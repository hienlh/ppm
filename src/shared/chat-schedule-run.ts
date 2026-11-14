/**
 * Marks a user message as a session schedule's run: PPM sent the schedule's prompt into the chat on
 * its own, at a time the user chose earlier, rather than the user typing it now. Carried as a block
 * in front of the prompt, so the first line the model reads says so before it reads the prompt.
 *
 * A prompt that is a slash command (`/skill args`) for a provider that runs one only when it opens
 * the message (Claude Code) carries the block after it instead: in front, it would turn the command
 * into prose. The header line then says the command is above rather than the prompt below.
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
/** How a block after a slash command ends: at the very end of the message (its other blocks aside). */
export const SCHEDULE_RUN_BLOCK_END_AFTER = "\n</ppm-schedule-run-v1>";
const START = SCHEDULE_RUN_BLOCK_START;
const END = SCHEDULE_RUN_BLOCK_END;
const END_AFTER = SCHEDULE_RUN_BLOCK_END_AFTER;
/** What separates a slash command from the block after it. */
const AFTER_GAP = "\n\n";

/** Where the block sits: in front of the prompt, or after a slash command that must stay first. */
export type ScheduleRunPlacement = "before" | "after";

/** The providers that run a message opening with `/name` as that command or skill. */
const SLASH_COMMAND_PROVIDERS: ReadonlySet<string> = new Set(["claude"]);

/** `content` opens with a slash command (`/name`), not a bare slash, a space or a `//` comment. */
export const startsWithSlashCommand = (content: string): boolean => /^\/[^\s/]/.test(content);

/**
 * Where a scheduled prompt's block goes for `providerId`. Claude Code runs a leading `/skill` as a
 * command, so the block goes after it. Codex runs no slash commands from a message (its own are
 * its terminal's) and finds a skill by its `$name` mention anywhere, which PPM's sigil rewrite has
 * already written, so the block stays in front there, as for every other prompt.
 */
export function scheduleRunPlacement(content: string, providerId: string): ScheduleRunPlacement {
  return SLASH_COMMAND_PROVIDERS.has(providerId) && startsWithSlashCommand(content) ? "after" : "before";
}

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

/**
 * The block's first line: the line the model reads first, or, after a slash command, the first line
 * past it. Every user-controlled part is quoted and escaped.
 */
export function scheduleRunHeaderLine(ref: ScheduleRunReference, placement: ScheduleRunPlacement = "before"): string {
  const when = [
    `cron ${quote(ref.cron)}${ref.timezone ? ` in ${ref.timezone}` : ""}`,
    `due ${ref.scheduledFor}`,
    ...(ref.catchUp ? ["sent late"] : []),
    ...(ref.coalesced ? ["later fires that came due meanwhile were folded into this one"] : []),
  ].join("; ");
  return `Automatic scheduled run from PPM schedule ${quote(ref.name)} (${when}). `
    + `This is not a message the user just typed: PPM sent the schedule's ${placement === "after" ? "command above" : "prompt below"} on its own, `
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
 * The block followed by `content` or, `after` a slash command, `content` followed by the block. Name
 * and cron are normalized here, so a caller may pass a schedule's own as stored; an empty name falls
 * back to the schedule's id.
 */
export function encodeScheduleRun(content: string, ref?: ScheduleRunReference | null, placement: ScheduleRunPlacement = "before"): string {
  if (!ref) return content;
  const valid = validateScheduleRun({
    ...ref,
    name: normalizeScheduleRunText(String(ref.name ?? ""), MAX_NAME) || `Schedule ${ref.scheduleId}`,
    cron: normalizeScheduleRunText(String(ref.cron ?? ""), MAX_CRON),
  });
  if (!valid) throw new Error("Invalid schedule-run reference");
  if (placement === "after") {
    if (!startsWithSlashCommand(content)) throw new Error("Only a slash command carries its schedule-run block after it");
    return `${content}${AFTER_GAP}${START}${scheduleRunHeaderLine(valid, "after")}\n${escapeJson(JSON.stringify(valid))}${END_AFTER}`;
  }
  return `${START}${scheduleRunHeaderLine(valid)}\n${escapeJson(JSON.stringify(valid))}${END}${content}`;
}

/** The reference in a block's inside (header line, then JSON), or null unless the two match. */
function readBlock(inner: string, placement: ScheduleRunPlacement): ScheduleRunReference | null {
  const split = inner.indexOf("\n");
  if (split < 0) return null;
  try {
    const ref = validateScheduleRun(JSON.parse(inner.slice(split + 1)));
    return ref && scheduleRunHeaderLine(ref, placement) === inner.slice(0, split) ? ref : null;
  } catch {
    return null; // malformed: keep it as text
  }
}

/** A block closing `text`: its start offset and the reference, or null. */
function trailingBlock(text: string): { at: number; ref: ScheduleRunReference } | null {
  if (!text.endsWith(END_AFTER)) return null;
  const at = text.lastIndexOf(START);
  if (at < 0) return null;
  const ref = readBlock(text.slice(at + START.length, text.length - END_AFTER.length), "after");
  return ref ? { at, ref } : null;
}

/**
 * Splits a schedule-run block off `content`: one leading the prompt, or one closing a slash command
 * (`/name …` then a blank line then the block). A block that is malformed, elsewhere, of another
 * version, or whose header does not match its own JSON and place stays visible text.
 */
export function decodeScheduleRun(content: string): { content: string; scheduleRun: ScheduleRunReference | null } {
  if (content.startsWith(START)) {
    const end = content.indexOf(END, START.length);
    const ref = end < 0 ? null : readBlock(content.slice(START.length, end), "before");
    return ref ? { content: content.slice(end + END.length), scheduleRun: ref } : { content, scheduleRun: null };
  }
  const block = trailingBlock(content);
  if (!block || block.at < AFTER_GAP.length || content.slice(block.at - AFTER_GAP.length, block.at) !== AFTER_GAP) {
    return { content, scheduleRun: null };
  }
  const command = content.slice(0, block.at - AFTER_GAP.length);
  return startsWithSlashCommand(command) ? { content: command, scheduleRun: block.ref } : { content, scheduleRun: null };
}

/**
 * Splits the block off a slash command's arguments as Claude Code records the command in its
 * transcript (`<command-args>…</command-args>`, trimmed): the arguments then the block, or the block
 * alone for a command sent with none. Only the server writes the block, and the text a message
 * carries has its markers broken (`neutralizeBlockMarkers`), so arguments cannot forge one.
 */
export function decodeScheduleRunInCommandArgs(args: string): { args: string; scheduleRun: ScheduleRunReference | null } {
  const block = trailingBlock(args);
  if (!block) return { args, scheduleRun: null };
  if (block.at === 0) return { args: "", scheduleRun: block.ref };
  if (args.slice(block.at - AFTER_GAP.length, block.at) !== AFTER_GAP) return { args, scheduleRun: null };
  return { args: args.slice(0, block.at - AFTER_GAP.length).trimEnd(), scheduleRun: block.ref };
}
