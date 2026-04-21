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
  getProjectSettingsJson,
  patchProjectSettingsJson,
} from "./db.service.ts";

/** Top-level config keys stored in the config table (not projects) */
const CONFIG_TABLE_KEYS: (keyof PpmConfig)[] = [
  "device_name", "port", "host", "theme", "auth", "ai", "push", "telegram", "clawbot",
];

/** File filter config keys stored in the config table */
export const FILE_CONFIG_KEYS = {
  filesExclude: "files.exclude",
  searchExclude: "files.searchExclude",
  useIgnoreFiles: "files.useIgnoreFiles",
} as const;

class ConfigService {
  private config: PpmConfig = structuredClone(DEFAULT_CONFIG);

  /** Load config from SQLite. Creates defaults if DB is empty. */
  load(): PpmConfig {
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

  /** Get the DB file path */
  getConfigPath(): string {
    return getDbFilePath();
  }

  /** Get global files.exclude patterns (falls back to empty array if not set) */
  getFilesExclude(): string[] {
    const raw = getConfigValue(FILE_CONFIG_KEYS.filesExclude);
    if (!raw) return [];
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }

  /** Get global files.searchExclude patterns */
  getSearchExclude(): string[] {
    const raw = getConfigValue(FILE_CONFIG_KEYS.searchExclude);
    if (!raw) return [];
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  }

  /** Get global files.useIgnoreFiles flag (default true) */
  getUseIgnoreFiles(): boolean {
    const raw = getConfigValue(FILE_CONFIG_KEYS.useIgnoreFiles);
    if (raw === null) return true; // default on
    try { return JSON.parse(raw) as boolean; } catch { return true; }
  }

  /** Get per-project settings for a given project path */
  getProjectSettings(projectPath: string): import("../types/project.ts").ProjectSettings {
    const json = getProjectSettingsJson(projectPath);
    try { return JSON.parse(json) as import("../types/project.ts").ProjectSettings; } catch { return {}; }
  }

  /** Merge-patch per-project settings */
  setProjectSettings(projectPath: string, patch: import("../types/project.ts").ProjectSettings): void {
    patchProjectSettingsJson(projectPath, JSON.stringify(patch));
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
}

/** Singleton config service */
export const configService = new ConfigService();
