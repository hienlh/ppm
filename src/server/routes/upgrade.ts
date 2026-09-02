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
  type LatestVersionCheck,
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

/** Newer of two versions, tolerating either being absent. */
function newerOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) < 0 ? b : a;
}

/**
 * Check the registry directly rather than only reading what the supervisor
 * recorded: that record is written 5min after startup and every 15min after,
 * so a UI opened inside that window would see no update and offer no upgrade.
 *
 * Take the newer of the two signals rather than "registry, else record". They
 * are produced by different processes on different clocks — the supervisor
 * checks the registry uncached every 15min, the server answers from a cache —
 * so either one can be the fresher of the pair, and preferring the registry
 * answer unconditionally withheld an update the supervisor had already found.
 *
 * `force` bypasses the server's cache for user-initiated checks.
 */
export async function resolveAvailableVersion(
  getLatest: LatestVersionCheck = getLatestPublishedVersion,
  opts?: { force?: boolean },
): Promise<string | null> {
  const candidate = newerOf(await getLatest(opts), readRecordedVersion());
  // Only report if actually newer than current version
  return candidate && compareSemver(VERSION, candidate) < 0 ? candidate : null;
}

/** GET / — upgrade status (current version, available version, install method).
 *  `?refresh=1` forces a live registry check, bypassing the status cache. */
upgradeRoutes.get("/", async (c) => {
  const force = c.req.query("refresh") === "1";
  const availableVersion = await resolveAvailableVersion(getLatestPublishedVersion, { force });

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
