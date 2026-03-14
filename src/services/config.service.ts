import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import yaml from "js-yaml";
import { DEFAULT_CONFIG } from "../types/config.ts";
import type { PpmConfig } from "../types/config.ts";

const HOME_CONFIG = join(homedir(), ".ppm", "config.yaml");
const LOCAL_CONFIG = "ppm.yaml";

export class ConfigService {
  private config: PpmConfig = { ...DEFAULT_CONFIG };
  private configPath: string = LOCAL_CONFIG;

  load(path?: string): PpmConfig {
    const candidates = [
      path,
      process.env["PPM_CONFIG"],
      LOCAL_CONFIG,
      HOME_CONFIG,
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      const abs = resolve(candidate);
      if (existsSync(abs)) {
        this.configPath = abs;
        const raw = readFileSync(abs, "utf8");
        const parsed = yaml.load(raw) as Partial<PpmConfig>;
        this.config = { ...DEFAULT_CONFIG, ...parsed };
        return this.config;
      }
    }

    // No config found — use defaults and set path for first save
    this.configPath = resolve(LOCAL_CONFIG);
    this.config = { ...DEFAULT_CONFIG };
    return this.config;
  }

  save(): void {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.configPath, yaml.dump(this.config), "utf8");
  }

  get<K extends keyof PpmConfig>(key: K): PpmConfig[K] {
    return this.config[key];
  }

  set<K extends keyof PpmConfig>(key: K, value: PpmConfig[K]): void {
    this.config[key] = value;
  }

  getConfig(): PpmConfig {
    return this.config;
  }

  getConfigPath(): string {
    return this.configPath;
  }
}

export const configService = new ConfigService();
