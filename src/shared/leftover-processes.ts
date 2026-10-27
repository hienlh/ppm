/**
 * How long PPM lets the processes an AI chat left running outlive the chat's last activity:
 * servers, emulators and daemons its commands started and walked away from. Shared by the
 * server, which stops them, and Settings, which edits the number.
 */

/** Unset means this. */
export const DEFAULT_LEFTOVER_IDLE_MINUTES = 30;
/** A day: anything longer is "never", which is 0. */
export const MAX_LEFTOVER_IDLE_MINUTES = 1440;

export function isValidLeftoverIdleMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_LEFTOVER_IDLE_MINUTES;
}

/** The configured minutes, or the default when the setting is absent or unusable. 0 = never stop them. */
export function leftoverIdleMinutes(ai: { leftover_processes_idle_minutes?: number } | undefined): number {
  const value = ai?.leftover_processes_idle_minutes;
  return isValidLeftoverIdleMinutes(value) ? value : DEFAULT_LEFTOVER_IDLE_MINUTES;
}
