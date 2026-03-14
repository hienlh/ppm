import type { Command } from "commander";
import { configService } from "../../services/config.service.ts";
import type { PpmConfig } from "../../types/config.ts";

function getNestedValue(obj: unknown, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return num;
  return value;
}

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Read and write config values");

  config
    .command("get <key>")
    .description("Get a config value (supports dot notation, e.g. auth.token)")
    .action((key: string) => {
      configService.load();
      const cfg = configService.getConfig() as unknown as Record<string, unknown>;
      const val = getNestedValue(cfg, key);
      if (val === undefined) {
        console.error(`Key not found: ${key}`);
        process.exit(1);
      }
      console.log(typeof val === "object" ? JSON.stringify(val, null, 2) : String(val));
    });

  config
    .command("set <key> <value>")
    .description("Set a config value (supports dot notation, e.g. port 9090)")
    .action((key: string, value: string) => {
      configService.load();
      const cfg = configService.getConfig() as unknown as Record<string, unknown>;
      setNestedValue(cfg, key, coerce(value));

      // Re-apply to configService by spreading back into typed config
      const topKey = key.split(".")[0] as keyof PpmConfig;
      configService.set(topKey, cfg[topKey] as PpmConfig[typeof topKey]);
      configService.save();
      console.log(`Set ${key} = ${value}`);
    });
}
