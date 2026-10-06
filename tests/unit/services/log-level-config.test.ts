/**
 * The `log_level` row is written by `ppm config set log_level …`, a separate process, while the
 * server runs and follows it (`startLogLevelSync`). The server's own config saves — a project
 * added, the theme changed — come from the copy it loaded at boot, and must not write that
 * copy's level back over the row.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { configService } from "../../../src/services/config.service.ts";
import { setConfigValue, deleteConfigValue } from "../../../src/services/db.service.ts";
import { readConfiguredLogLevel, LOG_LEVEL_CONFIG_KEY } from "../../../src/services/log-level-config.ts";
import { DEFAULT_CONFIG, sanitizeConfig } from "../../../src/types/config.ts";

describe("the log_level row", () => {
  afterEach(() => deleteConfigValue(LOG_LEVEL_CONFIG_KEY));

  it("survives a save by a server that loaded its config before the CLI changed it", () => {
    const atBoot = configService.get("log_level");
    const fromCli = atBoot === "debug" ? "warn" : "debug";
    // The CLI's write, from its own process: not through this process's configService.
    setConfigValue(LOG_LEVEL_CONFIG_KEY, JSON.stringify(fromCli));
    configService.save();
    expect(readConfiguredLogLevel()).toBe(fromCli);
  });

  it("is not repaired at load: save() no longer writes it, so a repair would only claim one", () => {
    // Every reader already takes a level it does not know for the default.
    const config = structuredClone(DEFAULT_CONFIG);
    (config as { log_level?: unknown }).log_level = "verbose";
    expect(sanitizeConfig(config)).toBe(false);
  });
});
