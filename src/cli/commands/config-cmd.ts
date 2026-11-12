import { Command } from "commander";
import type { PpmConfig } from "../../types/config.ts";
import { isSecretConfigKey, redactSecretConfigValue } from "../../services/config-secret-keys.ts";
import { configWriteRefusal, prepareConfigWrite } from "../../services/config-write-guard.ts";
import { inAiChat } from "../../services/ai-chat-env.ts";
import { flattenConfig, getNestedValue } from "../utils/config-key-path.ts";
import { noteDirectWrite, serverRequest, ServerDownError } from "../utils/ppm-server-client.ts";

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

const failWith = (msg: string): never => {
  console.error(`${C.red}Error:${C.reset} ${msg}`);
  process.exit(1);
};

/**
 * No server holds the database: the same checks the server's route makes, then the write. This is
 * what keeps `ppm init` followed by `ppm config set port 8081` working before PPM ever started.
 */
async function setDirectly(key: string, value: string): Promise<void> {
  const { configService } = await import("../../services/config.service.ts");
  configService.load();
  const all = configService.getAll() as unknown as Record<string, unknown>;
  const prepared = prepareConfigWrite(key, value, all, { aiChat: inAiChat() });
  if (!prepared.ok) return failWith(prepared.error);
  await noteDirectWrite();
  const topKey = prepared.topKey as keyof PpmConfig;
  configService.set(topKey, prepared.topValue as PpmConfig[typeof topKey]);
  configService.save();
  console.log(`${C.green}Updated:${C.reset} ${key} = ${prepared.value}`);
  console.log(`${C.cyan}Saved to:${C.reset} ${configService.getConfigPath()}`);
  // The supervisor owns cloudflared and caches its own copy of the config, so a write alone
  // would sit there until the next restart.
  if (key === "tunnel.enabled") {
    const { requestTunnelReload } = await import("../../services/supervisor-state.ts");
    const reload = requestTunnelReload();
    console.log(reload === "sent"
      ? `${C.cyan}Applied:${C.reset} asked the running PPM to ${prepared.value ? "start" : "stop"} its tunnel`
      : `${C.cyan}Note:${C.reset} no running supervisor to apply it to (${reload}) — takes effect on next start`);
  }
}

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Get or set PPM configuration");

  config
    .command("get <key>")
    .description("Get a config value (e.g. port, auth.enabled)")
    .action(async (key: string) => {
      try {
        if (isSecretConfigKey(key)) {
          console.log("(secret — use the API's masked status endpoint)");
          return;
        }
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
        // A leaf secret key is caught above; an ANCESTOR of one (e.g. "tunnel",
        // "auth") reaches here with the raw object still intact, so every
        // result — object or scalar — is deep-redacted before printing.
        const display = redactSecretConfigValue(key, value);
        if (typeof display === "object") {
          console.log(JSON.stringify(display, null, 2));
        } else {
          console.log(`${C.bold}${key}${C.reset} = ${C.green}${String(display)}${C.reset}`);
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  config
    .command("set <key> <value>")
    .description("Set a config value (e.g. port 9090), through the running PPM when one holds the database")
    .action(async (key: string, value: string) => {
      // Refused before anything is looked up: a secret on a command line is already a leak.
      const refusal = configWriteRefusal(key, { aiChat: inAiChat() });
      if (refusal) return failWith(refusal);
      try {
        const data = await serverRequest<{ key: string; value: unknown; note: string | null }>("PUT", "/settings/config-key", { key, value });
        console.log(`${C.green}Updated:${C.reset} ${data.key} = ${String(data.value)}`);
        if (data.note) console.log(`${C.cyan}Note:${C.reset} ${data.note}`);
      } catch (err) {
        if (err instanceof ServerDownError) {
          try { await setDirectly(key, value); } catch (e) { failWith((e as Error).message); }
          return;
        }
        failWith((err as Error).message);
      }
    });
}
