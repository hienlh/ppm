/**
 * What makes a session schedule valid: one prompt delivered into an existing chat on a cron. One
 * set of rules for the REST routes, the CLI and the AI's schedule tool, so none of them can save a
 * schedule another would refuse. Fields use camelCase; each caller translates its own spelling.
 *
 * A session schedule runs on its chat's own settings, so permission mode, turn cap and timeout
 * are not part of it; fields it does not know are left unread rather than refused.
 */
import { isTimeZone } from "./assistant-quiet-hours.ts";
import { cronProblem } from "./schedule-cron.ts";
import { SCHEDULE_LIMITS } from "./schedule-definition.ts";
import { SESSION_ID_RE } from "./session-turn-ids.ts";

/** Schedules one chat may have; counted by the server before it saves another. */
export const MAX_SCHEDULES_PER_SESSION = 20;

/** Longest name derived from the prompt when none is given. */
const DERIVED_NAME_CHARS = 60;

/** A checked session schedule, ready to store. */
export interface SessionScheduleInput {
  targetSessionId: string;
  name: string;
  prompt: string;
  cron: string;
  /** Canonical IANA name; null reads the cron in the machine's own zone. */
  timezone: string | null;
  recurring: boolean;
}

export type SessionScheduleCheck =
  | { ok: true; value: SessionScheduleInput }
  | { ok: false; errors: string[] };

/** Why `zone` cannot be a schedule's time zone, or null when it can (absent means the machine's). */
export function timezoneProblem(zone: unknown): string | null {
  if (zone === undefined || zone === null || zone === "") return null;
  if (typeof zone !== "string" || !isTimeZone(zone)) return "timezone must be an IANA time zone such as Europe/London";
  return null;
}

/** The runtime's own spelling of a valid zone (`asia/saigon` → `Asia/Saigon`), or null for none. */
function canonicalZone(zone: unknown): string | null {
  if (typeof zone !== "string" || !zone) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone }).resolvedOptions().timeZone;
}

/** A name for a schedule given none: the prompt's first line, cut short. */
function nameFromPrompt(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0]!.trim();
  return line.length > DERIVED_NAME_CHARS ? `${line.slice(0, DERIVED_NAME_CHARS - 1)}…` : line;
}

/** Check `raw` as a session schedule; every problem is listed, one sentence each. */
export function validateSessionScheduleInput(raw: Record<string, unknown>): SessionScheduleCheck {
  const { targetSessionId, name, prompt, cron, timezone, recurring } = raw;
  const errors: string[] = [];

  if (typeof targetSessionId !== "string" || !SESSION_ID_RE.test(targetSessionId)) {
    errors.push("targetSessionId must be the id of an existing chat");
  }
  if (typeof prompt !== "string" || !prompt.trim()) errors.push("A session schedule needs a prompt");
  else if (prompt.length > SCHEDULE_LIMITS.prompt) errors.push(`The prompt is longer than ${SCHEDULE_LIMITS.prompt} characters`);
  if (name !== undefined && name !== null && (typeof name !== "string" || name.length > SCHEDULE_LIMITS.name)) {
    errors.push(`name must be text of at most ${SCHEDULE_LIMITS.name} characters`);
  }
  if (recurring !== undefined && typeof recurring !== "boolean") errors.push("recurring must be true or false");

  const zoneProblem = timezoneProblem(timezone);
  if (zoneProblem) errors.push(zoneProblem);
  if (typeof cron !== "string" || !cron.trim()) errors.push("A session schedule needs a cron expression");
  else {
    // Read in the schedule's own zone, so "never fires" is judged where it will fire.
    const problem = cronProblem(cron.trim(), "session", zoneProblem ? null : (timezone as string | null | undefined));
    if (problem) errors.push(problem);
  }

  if (errors.length > 0) return { ok: false, errors };
  const text = prompt as string;
  const given = typeof name === "string" ? name.trim() : "";
  return {
    ok: true,
    value: {
      targetSessionId: targetSessionId as string,
      name: given || nameFromPrompt(text),
      prompt: text,
      cron: (cron as string).trim().split(/\s+/).join(" "),
      timezone: canonicalZone(timezone),
      recurring: recurring !== false,
    },
  };
}
