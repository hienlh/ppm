import { Command } from "commander";
import type { PpmConfig } from "../../types/config.ts";

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

type FlatConfig = Record<string, string | number | boolean>;

function flattenConfig(obj: unknown, prefix = ""): FlatConfig {
  const result: FlatConfig = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(result, flattenConfig(v, key));
    } else {
      result[key] = v as string | number | boolean;
    }
  }
  return result;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  // Coerce type based on existing value
  const existing = current[last];
  if (typeof existing === "number") {
    current[last] = Number(value);
  } else if (typeof existing === "boolean") {
    current[last] = value === "true" || value === "1";
  } else {
    current[last] = value;
  }
}

function getNestedValue(obj: unknown, keyPath: string): unknown {
  const parts = keyPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Get or set PPM configuration");

  config
    .command("get <key>")
    .description("Get a config value (e.g. port, auth.enabled)")
    .action(async (key: string) => {
      try {
        const { configService } = await import("../../services/config.service.ts");
        configService.load();
        const all = configService.getAll();
        const value = getNestedValue(all, key);
        if (value === undefined) {
          console.error(`${C.red}Error:${C.reset} Config key "${key}" not found`);
          console.log(`\nAvailable keys:`);
          const flat = flattenConfig(all);
          for (const k of Object.keys(flat).sort()) {
            console.log(`  ${C.cyan}${k}${C.reset}`);
          }
          process.exit(1);
        }
        if (typeof value === "object") {
          console.log(JSON.stringify(value, null, 2));
        } else {
          console.log(`${C.bold}${key}${C.reset} = ${C.green}${String(value)}${C.reset}`);
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  config
    .command("set <key> <value>")
    .description("Set a config value (e.g. port 9090)")
    .action(async (key: string, value: string) => {
      try {
        const { configService } = await import("../../services/config.service.ts");
        configService.load();
        const all = configService.getAll() as unknown as Record<string, unknown>;

        const existing = getNestedValue(all, key);
        if (existing === undefined) {
          console.error(`${C.red}Error:${C.reset} Config key "${key}" not found`);
          process.exit(1);
        }

        setNestedValue(all, key, value);

        // Re-apply back to config service via top-level keys
        const topKey = key.split(".")[0] as keyof PpmConfig;
        configService.set(topKey, all[topKey] as PpmConfig[typeof topKey]);
        configService.save();

        console.log(`${C.green}Updated:${C.reset} ${key} = ${value}`);
        console.log(`${C.cyan}Saved to:${C.reset} ${configService.getConfigPath()}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });
}
