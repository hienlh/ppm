import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "js-yaml";
import type { PpmConfig } from "../types/config.ts";
import { DEFAULT_CONFIG, sanitizeConfig } from "../types/config.ts";

const PPM_DIR = resolve(homedir(), ".ppm");
const GLOBAL_CONFIG_PATH = resolve(PPM_DIR, "config.yaml");
const LOCAL_CONFIG_PATH = resolve(process.cwd(), "ppm.yaml");

class ConfigService {
  private config: PpmConfig = structuredClone(DEFAULT_CONFIG);
  private configPath: string = GLOBAL_CONFIG_PATH;

  /** Load config from: explicit path → ./ppm.yaml → ~/.ppm/config.yaml */
  load(explicitPath?: string): PpmConfig {
    const searchPaths = [
      explicitPath,
      LOCAL_CONFIG_PATH,
      GLOBAL_CONFIG_PATH,
    ].filter(Boolean) as string[];

    for (const p of searchPaths) {
      const found = existsSync(p);
      if (!found) {
        console.log(`[config] Not found: ${p}`);
        continue;
      }
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = yaml.load(raw) as Partial<PpmConfig> | null;
        if (parsed) {
          this.config = { ...structuredClone(DEFAULT_CONFIG), ...parsed };
          this.configPath = p;
          console.log(`[config] Loaded from: ${p}`);
          // Auto-generate token if auth enabled but token is empty
          if (this.config.auth.enabled && !this.config.auth.token) {
            this.config.auth.token = randomBytes(16).toString("hex");
            this.save();
          }
          // Fix invalid config values and persist corrections
          if (sanitizeConfig(this.config)) {
            this.save();
          }
          return this.config;
        }
        console.log(`[config] Empty or invalid YAML: ${p}`);
      } catch (err) {
        console.error(`[config] Error reading ${p}:`, (err as Error).message);
      }
    }

    // No config found — create default
    console.log(`[config] No config found, creating default at ${GLOBAL_CONFIG_PATH}`);
    this.config = this.createDefault();
    return this.config;
  }

  /** Save current config to disk */
  save(): void {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.configPath, yaml.dump(this.config), "utf-8");
  }

  /** Get a top-level config key */
  get<K extends keyof PpmConfig>(key: K): PpmConfig[K] {
    return this.config[key];
  }

  /** Set a top-level config key */
  set<K extends keyof PpmConfig>(key: K, value: PpmConfig[K]): void {
    this.config[key] = value;
  }

  /** Get the full config object */
  getAll(): PpmConfig {
    return this.config;
  }

  /** Get the path config was loaded from */
  getConfigPath(): string {
    return this.configPath;
  }

  /** Set the config path explicitly (for init command) */
  setConfigPath(p: string): void {
    this.configPath = p;
  }

  /** Create default config with auto-generated auth token */
  private createDefault(): PpmConfig {
    const config = structuredClone(DEFAULT_CONFIG);
    config.auth.token = randomBytes(16).toString("hex");
    this.configPath = GLOBAL_CONFIG_PATH;
    this.save();
    return config;
  }
}

/** Singleton config service */
export const configService = new ConfigService();
