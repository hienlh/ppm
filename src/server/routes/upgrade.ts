import { Hono } from "hono";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { VERSION } from "../../version.ts";
import {
  getInstallMethod,
  compareSemver,
  applyUpgrade,
  signalSupervisorUpgrade,
} from "../../services/upgrade.service.ts";
import { ok, err } from "../../types/api.ts";

const STATUS_FILE = resolve(process.env.PPM_HOME || resolve(homedir(), ".ppm"), "status.json");

export const upgradeRoutes = new Hono();

/** GET / — upgrade status (current version, available version, install method) */
upgradeRoutes.get("/", (c) => {
  let availableVersion: string | null = null;
  try {
    if (existsSync(STATUS_FILE)) {
      const data = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
      const candidate = data.availableVersion ?? null;
      // Only report if actually newer than current version
      if (candidate && compareSemver(VERSION, candidate) < 0) {
        availableVersion = candidate;
      }
    }
  } catch {}

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
    return c.json(ok({
      success: true,
      newVersion: result.newVersion,
      restart: false,
      message: "Upgraded. Restart manually with ppm restart",
    }));
  }

  return c.json(ok({
    success: true,
    newVersion: result.newVersion,
    restart: true,
  }));
});
