/**
 * PPM's memory guard: the thresholds every part of it reads, in one place.
 *
 * Free commit below `warnFreeGB` → a notification naming the chat that is growing fastest.
 * Below `blockFreeGB` → new heavy commands (test runners, type checks, builds, e2e) are refused,
 * idle chat subprocesses are released, and a supervisor waiting to restart a server that died
 * of it keeps waiting. Thresholds are absolute GB, not a share of the limit: the limit moves when
 * Windows grows or shrinks its page file, and what a test run takes does not.
 *
 * `idleCliReleaseMinutes`: a chat's subprocess (and the MCP servers under it) is released once
 * the chat has been idle that long even with a tab open on it; 0 keeps it for as long as a tab is.
 *
 * Stored as `ai.memory_warn_free_gb`, `ai.memory_block_free_gb`, `ai.idle_cli_release_minutes`.
 */

export const DEFAULT_MEMORY_WARN_FREE_GB = 15;
export const DEFAULT_MEMORY_BLOCK_FREE_GB = 10;
export const DEFAULT_IDLE_CLI_RELEASE_MINUTES = 60;
export const MAX_MEMORY_FREE_GB = 512;
export const MAX_IDLE_CLI_RELEASE_MINUTES = 7 * 24 * 60;

export interface MemoryGuardSettings {
  warnFreeGB: number;
  blockFreeGB: number;
  idleCliReleaseMinutes: number;
}

export interface MemoryGuardConfig {
  memory_warn_free_gb?: number;
  memory_block_free_gb?: number;
  idle_cli_release_minutes?: number;
}

/** A free-commit threshold: a number of GB from 0 (off) to {@link MAX_MEMORY_FREE_GB}, halves allowed. */
export const isValidFreeGB = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_MEMORY_FREE_GB && Math.round(v * 2) === v * 2;

export const isValidIdleCliReleaseMinutes = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_IDLE_CLI_RELEASE_MINUTES;

/** The settings in force: anything missing or invalid falls back to its default. */
export function memoryGuardSettings(ai: MemoryGuardConfig | undefined): MemoryGuardSettings {
  const warn = isValidFreeGB(ai?.memory_warn_free_gb) ? ai!.memory_warn_free_gb! : DEFAULT_MEMORY_WARN_FREE_GB;
  const block = isValidFreeGB(ai?.memory_block_free_gb) ? ai!.memory_block_free_gb! : DEFAULT_MEMORY_BLOCK_FREE_GB;
  const idle = isValidIdleCliReleaseMinutes(ai?.idle_cli_release_minutes)
    ? ai!.idle_cli_release_minutes!
    : DEFAULT_IDLE_CLI_RELEASE_MINUTES;
  return { warnFreeGB: warn, blockFreeGB: block, idleCliReleaseMinutes: idle };
}

/** True when `freeMB` is under `thresholdGB`; a threshold of 0 is off. */
export const belowFreeGB = (freeMB: number, thresholdGB: number): boolean =>
  thresholdGB > 0 && freeMB < thresholdGB * 1024;
