/**
 * Which cron expressions a schedule may use, for the server, the CLI and the browser alike.
 *
 * A prompt keeps the 5-field form (a chat turn every minute is already the most anyone wants).
 * A script may add a seconds field in front — croner reads 6 fields that way — but may not fire
 * more often than every {@link SCRIPT_MIN_INTERVAL_MS}: each fire spawns a process.
 */
import { Cron } from "croner";
import type { ScheduleKind } from "../types/scheduler.ts";

export const SCRIPT_MIN_INTERVAL_MS = 5_000;

/** How many upcoming fires the interval check looks at. */
const SAMPLE = 20;

export function cronFieldCount(expr: string): number {
  return expr.trim().split(/\s+/).filter(Boolean).length;
}

/** Why `expr` cannot drive a schedule of `kind`, or null when it can. */
export function cronProblem(expr: string, kind: ScheduleKind): string | null {
  const fields = cronFieldCount(expr);
  if (kind === "prompt" && fields !== 5) {
    return "A prompt schedule takes 5 cron fields: minute hour day month weekday";
  }
  if (kind === "script" && fields !== 5 && fields !== 6) {
    return "A script schedule takes 5 cron fields, or 6 with seconds first";
  }
  let runs: Date[];
  try {
    runs = new Cron(expr).nextRuns(SAMPLE);
  } catch (e) {
    return `Invalid cron expression: ${(e as Error).message}`;
  }
  if (runs.length === 0) return "This cron expression never fires";
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < SCRIPT_MIN_INTERVAL_MS) {
      return `A schedule may fire at most every ${SCRIPT_MIN_INTERVAL_MS / 1000} seconds`;
    }
  }
  return null;
}

/** The next `n` fires after `from`; empty when the expression does not parse. */
export function nextFires(expr: string, n: number, from?: Date): Date[] {
  try {
    return new Cron(expr).nextRuns(n, from);
  } catch {
    return [];
  }
}
