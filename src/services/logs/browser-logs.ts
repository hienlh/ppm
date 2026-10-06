/**
 * The browsers' console lines, as Logs shows them. They are already stored: every tab sends its
 * console and its uncaught errors to `POST /api/trace` (`trace-client.ts`), redacted on the way
 * in. Here a row becomes a record tagged with the browser it came from ("Chrome·Mac").
 */
import type { LogEntry, LogLevel } from "../../shared/logs-model.ts";
import { userAgentTag } from "../../shared/user-agent-label.ts";
import { readTraceDevices, type BrowserTraceRow } from "../session-trace/session-trace-store.ts";
import { MAX_MESSAGE_CHARS, MAX_MORE_LINES } from "./log-file-index.ts";

const LEVEL_BY_TYPE: Readonly<Record<string, LogLevel>> = {
  console_debug: "debug",
  console_log: "info",
  console_info: "info",
  console_warn: "warn",
  console_dropped: "warn",
  console_error: "error",
  browser_error: "error",
  unhandled_rejection: "error",
  render_error: "error",
  chunk_error: "error",
  entry_never_ran: "fatal",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
}

/** The message and the lines under it, from a row's payload. */
function messageOf(type: string, p: Record<string, unknown>): { msg: string; more: string[] } {
  if (type.startsWith("console_") && Array.isArray(p.args)) {
    const [first = "", ...rest] = (p.args as unknown[]).map(str).join(" ").split("\n");
    return { msg: first, more: rest };
  }
  if (type === "console_dropped") return { msg: `${str(p.count) || "Some"} console lines were not kept (too many in a minute)`, more: [] };
  if (type === "entry_never_ran") {
    return { msg: `The app never started on ${str(p.path) || "this page"}${p.failed ? ` (failed to load: ${str(p.failed)})` : ""}`, more: [] };
  }
  const lead = type === "unhandled_rejection" ? "Unhandled rejection: "
    : type === "render_error" ? "Render error: "
    : type === "chunk_error" ? "A part of the app failed to load: "
    : "";
  const name = typeof p.name === "string" && p.name ? `${p.name}: ` : "";
  const message = str(p.message);
  const stack = typeof p.stack === "string" ? p.stack.split("\n") : [];
  // A stack usually repeats "Name: message" as its first line.
  if (stack.length && message && stack[0]!.includes(message)) stack.shift();
  return { msg: `${lead}${name}${message}`, more: stack };
}

/** Tags for every device, made unique when two devices are the same browser on the same system. */
export function deviceTags(deviceIds: Iterable<string>, agents: ReadonlyMap<string, string> = readTraceDevices()): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Map<string, number>();
  for (const id of [...new Set(deviceIds)].sort()) {
    const ua = agents.get(id);
    const base = ua ? userAgentTag(ua) : `Browser·${id.slice(0, 4)}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    out.set(id, n === 1 ? base : `${base} ${n}`);
  }
  return out;
}

export function browserEntry(row: BrowserTraceRow, tag: string): LogEntry {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payloadJson);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch { /* a row we cannot read still shows as an empty line of its type */ }
  let { msg, more } = messageOf(row.type, payload);
  if (msg.length > MAX_MESSAGE_CHARS) msg = `${msg.slice(0, MAX_MESSAGE_CHARS)}…`;
  if (more.length > MAX_MORE_LINES) more = [...more.slice(0, MAX_MORE_LINES), `… ${more.length - MAX_MORE_LINES} more lines`];
  const entry: LogEntry = { id: `b${row.rowid.toString(36)}`, ts: row.ts, lv: LEVEL_BY_TYPE[row.type] ?? "info", src: "browser", tag, msg };
  if (more.length) entry.more = more;
  if (row.refId && UUID.test(row.refId)) entry.sid = row.refId;
  return entry;
}

export function deviceIdOf(row: BrowserTraceRow): string {
  return row.traceId.startsWith("browser:") ? row.traceId.slice("browser:".length) : row.traceId;
}
