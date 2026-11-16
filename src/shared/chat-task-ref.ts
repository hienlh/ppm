/**
 * A PPM task a user message is about, carried as a block after the text the person typed: the
 * task the user opened the chat from ("Open chat" on a task), or the one they picked on Telegram.
 * A manager chat works on many tasks at once, and without it "fix it now" names none of them.
 *
 * Only the server writes one. The browser and the Telegram bridge send a task id; the server reads
 * the task from the store, checks it belongs to the chat's project, and renders the block from
 * what the store says (`src/services/ppm-tasks/task-chat-ref.ts`). A block in typed or pasted text
 * never decodes: `neutralizeBlockMarkers` breaks its markers at every door.
 *
 * The block says the facts plainly for the AI — ref, id, title, status, urgency, due date, link —
 * and repeats them as one base64 line for the bubble's chip. The decoder rebuilds the whole block
 * from that line and keeps it as text unless the two match byte for byte, so the readable lines
 * cannot say anything the chip does not. The title is written as a JSON string with `<`, `>` and
 * `&` escaped, so it cannot close the block or open a tag.
 */
import type { Urgency } from "./ppm-tasks";

export interface TaskReference {
  version: 1;
  taskId: string;
  /** `ppm/12`. */
  ref: string;
  /** The task's number in its project (the `12` of `ppm/12`). */
  number: number;
  projectName: string;
  title: string;
  /** The status's name, as the project calls it. */
  status: string;
  /** The effective urgency: the stored one, raised by the due date. */
  urgency: Urgency;
  /** `YYYY-MM-DD`, or null. */
  due: string | null;
  /** An absolute link that opens the task in PPM. */
  link: string;
}

export const MAX_TASK_REFS = 5;
const MAX_TITLE = 300;
const MAX_NAME = 200;
const MAX_STATUS = 80;
const MAX_LINK = 600;
const MAX_NUMBER = 10_000_000;
const URGENCIES: readonly Urgency[] = ["now", "today", "week", "later"];
const URGENCY_TEXT: Record<Urgency, string> = { now: "Now", today: "Today", week: "This week", later: "Later" };
export const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
// Every character that could end a line, in any reader's sense of one.
const LINE_BREAKS = new RegExp(`[\\u0000-\\u001f\\u007f${String.fromCharCode(0x2028, 0x2029)}]`);
const JSON_UNSAFE = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const TASK_REFS_BLOCK_START = "\n\n<ppm-taskref-v1>\n"
  + "The user's message above is about the PPM task below; PPM attached it (the user opened this chat from the task, "
  + "or picked the task on Telegram). Read \"this task\", \"it\" and the like in the message as this task unless the "
  + "user says otherwise. For more than these fields, call ppm_task_get with the task id.\n";
export const TASK_REFS_BLOCK_END = "\n</ppm-taskref-v1>";
const DISPLAY_PREFIX = "Display data for the user's chip (base64; the same facts as above, nothing more to read here): ";

const isLine = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim() !== "" && Array.from(v).length <= max && !LINE_BREAKS.test(v);

/** One reference, checked: every field one PPM's renderer writes, or null. */
export function validateTaskRef(value: unknown): TaskReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!["version", "taskId", "ref", "number", "projectName", "title", "status", "urgency", "due", "link"].includes(key)) return null;
  }
  if (v.version !== 1) return null;
  if (typeof v.taskId !== "string" || !TASK_ID_RE.test(v.taskId)) return null;
  if (!isLine(v.ref, MAX_NAME + 12) || !isLine(v.projectName, MAX_NAME) || !isLine(v.title, MAX_TITLE) || !isLine(v.status, MAX_STATUS)) return null;
  if (typeof v.number !== "number" || !Number.isInteger(v.number) || v.number < 1 || v.number > MAX_NUMBER) return null;
  if (typeof v.urgency !== "string" || !URGENCIES.includes(v.urgency as Urgency)) return null;
  if (v.due !== null && (typeof v.due !== "string" || !YMD_RE.test(v.due))) return null;
  if (!isLine(v.link, MAX_LINK) || !/^https?:\/\/[^\s<>"]+$/.test(v.link)) return null;
  return {
    version: 1, taskId: v.taskId.toLowerCase(), ref: v.ref, number: v.number, projectName: v.projectName, title: v.title,
    status: v.status, urgency: v.urgency as Urgency, due: v.due as string | null, link: v.link,
  };
}

/** 1 to {@link MAX_TASK_REFS} valid references, no task twice; null otherwise (an empty list too). */
export function validateTaskRefs(value: unknown): TaskReference[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TASK_REFS) return null;
  const out: TaskReference[] = [];
  for (const item of value) {
    const ref = validateTaskRef(item);
    if (!ref || out.some((r) => r.taskId === ref.taskId)) return null;
    out.push(ref);
  }
  return out;
}

/** Task ids as a browser or a bot sends them: 1 to {@link MAX_TASK_REFS} distinct ids, else null. */
export function validateTaskIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TASK_REFS) return null;
  const ids = value.map((id) => (typeof id === "string" && TASK_ID_RE.test(id) ? id.toLowerCase() : null));
  if (ids.some((id) => id === null)) return null;
  return new Set(ids).size === ids.length ? (ids as string[]) : null;
}

/** A string as JSON, with nothing in it that reads as a tag or ends a line. */
const quoted = (text: string): string =>
  JSON.stringify(text).replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The lines the AI reads for one task. */
export function taskRefLines(ref: TaskReference): string {
  return [
    `Task ${quoted(ref.ref)} (task_id ${ref.taskId}): ${quoted(ref.title)}`,
    `Project ${quoted(ref.projectName)} · status ${quoted(ref.status)} · urgency ${URGENCY_TEXT[ref.urgency]} · due ${ref.due ?? "none"}`,
    `Open it: ${ref.link}`,
  ].join("\n");
}

function toBase64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(line: string): string | null {
  if (!line || line.length % 4 !== 0 || !BASE64_RE.test(line)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(line), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function block(refs: readonly TaskReference[]): string {
  return `${TASK_REFS_BLOCK_START}${refs.map(taskRefLines).join("\n")}\n${DISPLAY_PREFIX}${toBase64(JSON.stringify(refs))}${TASK_REFS_BLOCK_END}`;
}

/** `content` followed by the tasks' block; unchanged when there are none. Throws on a bad reference. */
export function encodeTaskRefs(content: string, refs?: readonly TaskReference[] | null): string {
  if (!refs?.length) return content;
  const valid = validateTaskRefs(refs);
  if (!valid) throw new Error("Invalid task references");
  return `${content}${block(valid)}`;
}

/** Splits a trailing tasks block off `content`; one that does not rebuild exactly stays text. */
export function decodeTaskRefs(content: string): { content: string; taskRefs: TaskReference[] | null } {
  if (!content.endsWith(TASK_REFS_BLOCK_END)) return { content, taskRefs: null };
  const at = content.lastIndexOf(TASK_REFS_BLOCK_START);
  if (at < 0) return { content, taskRefs: null };
  const inner = content.slice(at + TASK_REFS_BLOCK_START.length, content.length - TASK_REFS_BLOCK_END.length);
  const last = inner.slice(inner.lastIndexOf("\n") + 1);
  if (!last.startsWith(DISPLAY_PREFIX)) return { content, taskRefs: null };
  const json = fromBase64(last.slice(DISPLAY_PREFIX.length));
  if (json === null) return { content, taskRefs: null };
  let refs: TaskReference[] | null;
  try {
    refs = validateTaskRefs(JSON.parse(json));
  } catch {
    return { content, taskRefs: null };
  }
  if (!refs || block(refs) !== content.slice(at)) return { content, taskRefs: null };
  return { content: content.slice(0, at), taskRefs: refs };
}
