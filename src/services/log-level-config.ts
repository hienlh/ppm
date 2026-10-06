/**
 * Keeping a process's log level in step with the `log_level` config row.
 *
 * `ppm config set log_level debug` writes the row from a separate CLI process, while the server
 * holds the copy of the config it loaded at boot — so the row itself is read again on a timer
 * rather than asking anyone to restart PPM (which, from inside PPM, kills the session doing it).
 * One indexed SQLite read every 10 s; each change is on record in `ppm.log` as
 * `Log level info → debug`. `PPM_LOG_LEVEL`, when set, wins over the row (see `logger.ts`).
 */
import { getConfigValue } from "./db.service.ts";
import { applyConfiguredLogLevel } from "./logger.ts";

export const LOG_LEVEL_CONFIG_KEY = "log_level";
const SYNC_INTERVAL_MS = 10_000;

/** The row's value: stored as JSON (`"debug"`) by `configService`, tolerated bare. */
export function readConfiguredLogLevel(): unknown {
  const raw = getConfigValue(LOG_LEVEL_CONFIG_KEY);
  if (raw === null) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function syncLogLevel(): void {
  // A busy or closed database keeps the level it already has.
  try { applyConfiguredLogLevel(readConfiguredLogLevel()); } catch { /* keep the current level */ }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Apply the configured level now, then follow the row. Once per process. */
export function startLogLevelSync(intervalMs = SYNC_INTERVAL_MS): void {
  syncLogLevel();
  if (timer) return;
  timer = setInterval(syncLogLevel, intervalMs);
  timer.unref?.();
}
