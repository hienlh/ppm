/**
 * What to stop, decided from a snapshot: no filesystem, no clock, no systemd. The service takes
 * the snapshot and does the stopping.
 */
import { COMMAND_SCOPE_PREFIX } from "./session-slice.ts";

export interface UnitSnapshot {
  /** `ppmcmd-<uuid>.scope` for a command, or whatever the agent named its own unit. */
  name: string;
  /** Process names in it, for the log. */
  comms: string[];
  /**
   * Some process in it descends from a live process of PPM's own — the chat's CLI. That is a
   * command or MCP server running right now; everything else was left behind by one.
   */
  attached: boolean;
}

export interface SessionClock {
  /** When this process first saw the session's slice populated. */
  firstSeenAt: number;
  /** The latest moment the session was seen busy or known to have ended a turn. */
  lastActiveAt: number;
}

/** Note what the session is doing now; returns the clock to keep. */
export function advanceClock(clock: SessionClock | undefined, now: number, busy: boolean, lastActiveAt?: number): SessionClock {
  const next = clock ? { ...clock } : { firstSeenAt: now, lastActiveAt: 0 };
  if (busy) next.lastActiveAt = now;
  else if (lastActiveAt) next.lastActiveAt = Math.max(next.lastActiveAt, lastActiveAt);
  return next;
}

/**
 * Idle long enough to clean up after. Measured from the later of the session's last activity and
 * the moment this process first saw its slice, so a restart never stops anything early.
 */
export function idlePastLimit(clock: SessionClock, now: number, busy: boolean, idleMs: number): boolean {
  if (busy || idleMs <= 0) return false;
  return now - Math.max(clock.firstSeenAt, clock.lastActiveAt) >= idleMs;
}

export const isCommandScope = (unit: string) => unit.startsWith(COMMAND_SCOPE_PREFIX);

/**
 * Units to stop, never one with a live command in it. Idle: everything the session left. At
 * startup: only what its commands left, which died with PPM before the commands had scopes of
 * their own — a unit the agent made with `systemd-run` outlived a restart then too.
 */
export function unitsToStop(units: UnitSnapshot[], why: "idle" | "startup"): UnitSnapshot[] {
  return units.filter((u) => !u.attached && (why === "idle" || isCommandScope(u.name)));
}

/** `ppm-tablet-emulator.service (qemu-system-x86, netsimd), command (sleep ×2)`, capped for one log line. */
export function describeUnits(units: UnitSnapshot[], max = 400): string {
  const text = units.map((u) => {
    const counts = new Map<string, number>();
    for (const c of u.comms) counts.set(c, (counts.get(c) ?? 0) + 1);
    const what = [...counts].map(([c, n]) => (n > 1 ? `${c} ×${n}` : c)).join(", ");
    return `${isCommandScope(u.name) ? "command" : u.name}${what ? ` (${what})` : ""}`;
  }).join(", ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
