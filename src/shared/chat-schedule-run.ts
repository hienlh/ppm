/**
 * Marks a user message as a session schedule's run: PPM sent the schedule's prompt into the chat on
 * its own, at a time the user chose earlier, rather than the user typing it now. Carried as a block
 * in front of the prompt, so the first line the model reads says so before it reads the prompt.
 *
 * Only the server writes one, after its own checks; every other door breaks its markers in the text
 * it is handed (see `chat-message-blocks.ts`), so a typed or pasted message can never pose as a run.
 *
 * The header line repeats the block's JSON for the model. The schedule's name and cron are
 * user-controlled, so in that line they are collapsed to one line and JSON-quoted with `<`, `>` and
 * `&` escaped; the decoder rebuilds the header from the JSON and keeps the block as text unless the
 * two match.
 */
export interface ScheduleRunReference {
  version: 1;
  /** The schedule that fired (`schedules.id`). */
  scheduleId: number;
  /** The schedule's name, collapsed to one line (see {@link normalizeScheduleRunText}). */
  name: string;
  /** The cron expression the schedule fires on, collapsed to one line. */
  cron: string;
  /** The IANA zone the cron is read in; null for the machine's own. */
  timezone: string | null;
  /** ISO time the fire came due. */
  scheduledFor: string;
  /** ISO time PPM sent it into the chat. */
  firedAt: string;
  /** Sent well after it came due (PPM was off, or the chat was busy). */
  catchUp: boolean;
  /** Later fires came due before this one was sent and were folded into it. */
  coalesced: boolean;
}

const MAX_NAME = 200;
const MAX_CRON = 200;
const MAX_ZONE = 64;
const ZONE_RE = /^[A-Za-z0-9_+\-/]+$/;

/** The exact text that opens and closes a schedule-run block; nothing else decodes as one. */
export const SCHEDULE_RUN_BLOCK_START = "<ppm-schedule-run-v1>\n";
export const SCHEDULE_RUN_BLOCK_END = "\n</ppm-schedule-run-v1>\n\n";
const START = SCHEDULE_RUN_BLOCK_START;
const END = SCHEDULE_RUN_BLOCK_END;

const LINE_BREAKING = new RegExp(`[\\s\\u0000-\\u001f\\u007f${String.fromCharCode(0x2028, 0x2029)}]+`, "g");

/** Text as the block carries it: one line, single spaces, at most `max` characters. */
export function normalizeScheduleRunText(text: string, max = MAX_NAME): string {
  return Array.from(text.replace(LINE_BREAKING, " ").trim()).slice(0, max).join("").trim();
}

/** `<`, `>` and `&` (so nothing can close the block) and the two JS line separators. */
const JSON_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const escapeJson = (json: string): string =>
  json.replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const quote = (text: string): string => escapeJson(JSON.stringify(text));

/** The line the model reads first. Every user-controlled part is quoted and escaped. */
export function scheduleRunHeaderLine(ref: ScheduleRunReference): string {
  const when = [
    `cron ${quote(ref.cron)}${ref.timezone ? ` in ${ref.timezone}` : ""}`,
    `due ${ref.scheduledFor}`,
    ...(ref.catchUp ? ["sent late"] : []),
    ...(ref.coalesced ? ["later fires that came due meanwhile were folded into this one"] : []),
  ].join("; ");
  return `Automatic scheduled run from PPM schedule ${quote(ref.name)} (${when}). `
    + "This is not a message the user just typed: PPM sent the schedule's prompt below on its own, "
    + "on a schedule the user set up earlier, and the user may not be watching.";
}

const isIso = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v));

/** A reference, checked; null when any field is not one PPM's encoder would write. */
export function validateScheduleRun(value: unknown): ScheduleRunReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return null;
  if (typeof v.scheduleId !== "number" || !Number.isSafeInteger(v.scheduleId) || v.scheduleId <= 0) return null;
  if (typeof v.name !== "string" || !v.name || normalizeScheduleRunText(v.name, MAX_NAME) !== v.name) return null;
  if (typeof v.cron !== "string" || !v.cron || normalizeScheduleRunText(v.cron, MAX_CRON) !== v.cron) return null;
  if (v.timezone !== null && (typeof v.timezone !== "string" || v.timezone.length > MAX_ZONE || !ZONE_RE.test(v.timezone))) return null;
  if (!isIso(v.scheduledFor) || !isIso(v.firedAt)) return null;
  if (typeof v.catchUp !== "boolean" || typeof v.coalesced !== "boolean") return null;
  return {
    version: 1, scheduleId: v.scheduleId, name: v.name, cron: v.cron, timezone: v.timezone as string | null,
    scheduledFor: new Date(Date.parse(v.scheduledFor)).toISOString(),
    firedAt: new Date(Date.parse(v.firedAt)).toISOString(),
    catchUp: v.catchUp, coalesced: v.coalesced,
  };
}

/**
 * The block followed by `content`. Name and cron are normalized here, so a caller may pass a
 * schedule's own as stored; an empty name falls back to the schedule's id.
 */
export function encodeScheduleRun(content: string, ref?: ScheduleRunReference | null): string {
  if (!ref) return content;
  const valid = validateScheduleRun({
    ...ref,
    name: normalizeScheduleRunText(String(ref.name ?? ""), MAX_NAME) || `Schedule ${ref.scheduleId}`,
    cron: normalizeScheduleRunText(String(ref.cron ?? ""), MAX_CRON),
  });
  if (!valid) throw new Error("Invalid schedule-run reference");
  return `${START}${scheduleRunHeaderLine(valid)}\n${escapeJson(JSON.stringify(valid))}${END}${content}`;
}

/**
 * Splits a leading schedule-run block off `content`. A block that is malformed, not at the start,
 * of another version, or whose header does not match its own JSON stays visible text.
 */
export function decodeScheduleRun(content: string): { content: string; scheduleRun: ScheduleRunReference | null } {
  if (!content.startsWith(START)) return { content, scheduleRun: null };
  const end = content.indexOf(END, START.length);
  if (end < 0) return { content, scheduleRun: null };
  const inner = content.slice(START.length, end);
  const split = inner.indexOf("\n");
  if (split < 0) return { content, scheduleRun: null };
  try {
    const ref = validateScheduleRun(JSON.parse(inner.slice(split + 1)));
    if (ref && scheduleRunHeaderLine(ref) === inner.slice(0, split)) {
      return { content: content.slice(end + END.length), scheduleRun: ref };
    }
  } catch { /* malformed: keep it as text */ }
  return { content, scheduleRun: null };
}
