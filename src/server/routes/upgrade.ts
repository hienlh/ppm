import { Hono } from "hono";
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { VERSION } from "../../version.ts";
import {
  getInstallMethod,
  compareSemver,
  applyUpgrade,
  signalSupervisorUpgrade,
  getLatestPublishedVersion,
} from "../../services/upgrade.service.ts";
import { ok, err } from "../../types/api.ts";
import { getPpmDir } from "../../services/ppm-dir.ts";

export const upgradeRoutes = new Hono();

/** Last version the supervisor's periodic check recorded, if any. */
function readRecordedVersion(): string | null {
  try {
    const path = resolve(getPpmDir(), "status.json");
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")).availableVersion ?? null;
  } catch {
    return null;
  }
}

/**
 * Check the registry directly rather than only reading what the supervisor
 * recorded: that record is written 5min after startup and every 15min after,
 * so a UI opened inside that window would see no update and offer no upgrade.
 * The supervisor's record is the offline fallback.
 */
export async function resolveAvailableVersion(
  getLatest: () => Promise<string | null> = getLatestPublishedVersion,
): Promise<string | null> {
  const candidate = (await getLatest()) ?? readRecordedVersion();
  // Only report if actually newer than current version
  return candidate && compareSemver(VERSION, candidate) < 0 ? candidate : null;
}

/** GET / — upgrade status (current version, available version, install method) */
upgradeRoutes.get("/", async (c) => {
  const availableVersion = await resolveAvailableVersion();

  return c.json(ok({
    currentVersion: VERSION,
    availableVersion,
    installMethod: getInstallMethod(),
  }));
});

/** POST /apply — install latest version + signal supervisor to self-replace */
upgradeRoutes.post("/apply", async (c) => {
  const result = await applyUpgrade();
  if (!result.success) {
    return c.json(err(result.error ?? "Upgrade failed"), 500);
  }

  // Signal supervisor to self-replace
  const signal = signalSupervisorUpgrade();
  if (!signal.sent) {
    console.warn(`[upgrade] Supervisor signal failed: ${signal.error ?? "unknown"}`);
    return c.json(ok({
      success: true,
      newVersion: result.newVersion,
      restart: false,
      message: `Upgraded to v${result.newVersion}. Restart manually: ppm restart (signal failed: ${signal.error ?? "unknown"})`,
    }));
  }

  return c.json(ok({
    success: true,
    newVersion: result.newVersion,
    restart: true,
  }));
});
