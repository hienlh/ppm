import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { PpmConfig, ProjectConfig } from "../types/config.ts";
import { DEFAULT_CONFIG, sanitizeConfig } from "../types/config.ts";
import {
  getConfigValue,
  setConfigValue,
  getAllConfig,
  getProjects,
  upsertProject,
  deleteProject as dbDeleteProject,
  getDb,
  getDbFilePath,
} from "./db.service.ts";

const PPM_DIR = resolve(homedir(), ".ppm");

/** Top-level config keys stored in the config table (not projects) */
const CONFIG_TABLE_KEYS: (keyof PpmConfig)[] = [
  "device_name", "port", "host", "theme", "auth", "ai", "push",
];

class ConfigService {
  private config: PpmConfig = structuredClone(DEFAULT_CONFIG);

  /** Load config from DB. If explicitPath given, import that YAML first. */
  load(explicitPath?: string): PpmConfig {
    // Import explicit YAML if provided (e.g. `ppm start -c path`)
    if (explicitPath && existsSync(explicitPath)) {
      this.importFromYaml(explicitPath);
    }

    // Auto-migrate: if config.yaml exists but DB has no config rows
    // Skip migration when using in-memory DB (tests)
    if (!getDbFilePath().includes(":memory:")) {
      this.migrateYamlIfNeeded();
    }

    // Load from DB
    const dbConfig = getAllConfig();
    const dbProjects = getProjects();

    if (Object.keys(dbConfig).length > 0 || dbProjects.length > 0) {
      this.config = this.assembleConfig(dbConfig, dbProjects);
      console.log("[config] Loaded from SQLite");
    } else {
      console.log("[config] No config found, creating defaults");
      this.config = this.createDefault();
    }

    // Auto-generate token if auth enabled but empty
    if (this.config.auth.enabled && !this.config.auth.token) {
      this.config.auth.token = randomBytes(16).toString("hex");
      this.save();
    }

    if (sanitizeConfig(this.config)) {
      this.save();
    }

    return this.config;
  }

  /** Save current config to DB */
  save(): void {
    for (const key of CONFIG_TABLE_KEYS) {
      const value = this.config[key];
      if (value !== undefined) {
        setConfigValue(String(key), JSON.stringify(value));
      }
    }
    // Sync projects to DB
    this.syncProjectsToDb(this.config.projects);
  }

  /** Get a top-level config key */
  get<K extends keyof PpmConfig>(key: K): PpmConfig[K] {
    return this.config[key];
  }

  /** Set a top-level config key (persists immediately) */
  set<K extends keyof PpmConfig>(key: K, value: PpmConfig[K]): void {
    this.config[key] = value;
    if (key === "projects") {
      this.syncProjectsToDb(value as ProjectConfig[]);
    } else {
      setConfigValue(String(key), JSON.stringify(value));
    }
  }

  /** Get the full config object */
  getAll(): PpmConfig {
    return this.config;
  }

  /** Get the DB file path (replaces getConfigPath for YAML) */
  getConfigPath(): string {
    return getDbFilePath();
  }

  /** No-op — kept for backward compatibility (init command) */
  setConfigPath(_p: string): void {}

  // ── Private helpers ──────────────────────────────────────────────────

  private createDefault(): PpmConfig {
    const config = structuredClone(DEFAULT_CONFIG);
    config.auth.token = randomBytes(16).toString("hex");
    this.config = config;
    this.save();
    return config;
  }

  private assembleConfig(
    dbRows: Record<string, string>,
    dbProjects: { path: string; name: string; color: string | null }[],
  ): PpmConfig {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const [key, jsonValue] of Object.entries(dbRows)) {
      if (key in config && key !== "projects") {
        try {
          (config as any)[key] = JSON.parse(jsonValue);
        } catch { /* keep default */ }
      }
    }
    // Projects from dedicated table
    config.projects = dbProjects.map((p) => ({
      path: p.path,
      name: p.name,
      ...(p.color ? { color: p.color } : {}),
    }));
    return config;
  }

  private syncProjectsToDb(projects: ProjectConfig[]): void {
    const db = getDb();
    db.exec("DELETE FROM projects");
    const stmt = db.query(
      "INSERT INTO projects (path, name, color, sort_order) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i]!;
      stmt.run(p.path, p.name, p.color ?? null, i);
    }
  }

  private migrateYamlIfNeeded(): void {
    const yamlPaths = [
      resolve(PPM_DIR, "config.yaml"),
      resolve(PPM_DIR, "config.dev.yaml"),
    ];
    for (const yamlPath of yamlPaths) {
      if (!existsSync(yamlPath)) continue;
      const existing = getAllConfig();
      if (Object.keys(existing).length > 0) return;
      this.importFromYaml(yamlPath);
      try {
        renameSync(yamlPath, yamlPath + ".bak");
        console.log(`[config] Migrated ${yamlPath} → SQLite (backup: .bak)`);
      } catch {}
    }
    this.migrateSessionMapIfNeeded();
    this.migratePushSubsIfNeeded();
  }

  private importFromYaml(path: string): void {
    try {
      const yaml = require("js-yaml");
      const raw = readFileSync(path, "utf-8");
      const parsed = yaml.load(raw) as Partial<PpmConfig> | null;
      if (!parsed) return;
      const merged = { ...structuredClone(DEFAULT_CONFIG), ...parsed };
      for (const key of CONFIG_TABLE_KEYS) {
        const value = (merged as any)[key];
        if (value !== undefined) {
          setConfigValue(String(key), JSON.stringify(value));
        }
      }
      if (merged.projects?.length) {
        this.syncProjectsToDb(merged.projects);
      }
    } catch (err) {
      console.error(`[config] Error importing YAML ${path}:`, (err as Error).message);
    }
  }

  private migrateSessionMapIfNeeded(): void {
    const mapPath = resolve(PPM_DIR, "session-map.json");
    if (!existsSync(mapPath)) return;
    try {
      const { setSessionMapping } = require("./db.service.ts");
      const map = JSON.parse(readFileSync(mapPath, "utf-8")) as Record<string, string>;
      for (const [ppmId, sdkId] of Object.entries(map)) {
        setSessionMapping(ppmId, sdkId);
      }
      renameSync(mapPath, mapPath + ".bak");
      console.log("[config] Migrated session-map.json → SQLite");
    } catch {}
  }

  private migratePushSubsIfNeeded(): void {
    const subsPath = resolve(PPM_DIR, "push-subscriptions.json");
    if (!existsSync(subsPath)) return;
    try {
      const { upsertPushSubscription } = require("./db.service.ts");
      const subs = JSON.parse(readFileSync(subsPath, "utf-8")) as Array<{
        endpoint: string;
        keys: { p256dh: string; auth: string };
        expirationTime?: number | null;
      }>;
      for (const sub of subs) {
        upsertPushSubscription(
          sub.endpoint,
          sub.keys.p256dh,
          sub.keys.auth,
          sub.expirationTime != null ? String(sub.expirationTime) : null,
        );
      }
      renameSync(subsPath, subsPath + ".bak");
      console.log("[config] Migrated push-subscriptions.json → SQLite");
    } catch {}
  }
}

/** Singleton config service */
export const configService = new ConfigService();
