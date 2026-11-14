/**
 * How one line of a codex app-server's stderr reaches PPM's log.
 *
 * Every line names the login it came from (`account=<first 8 chars of the account id>` or
 * `account=ambient` for `~/.codex`), because codex's own lines never do. And the same
 * error is written loudly once per account per hour: codex prints a failed token refresh
 * six times per process, and the usage sweep starts one process per account every five
 * minutes, which put the same unattributed line into the log hundreds of times a day.
 * Repeats still go out at DEBUG, and the next loud line says how many there were.
 */
import { redactTruncate } from "./codex-redact.ts";

const REPEAT_WINDOW_MS = 60 * 60 * 1000;
/** Distinct (account, message) pairs remembered; the oldest is dropped past this. */
const MAX_TRACKED = 256;
/** codex's tracing prefix, e.g. `2026-11-14T13:46:02.779305Z `, which differs on every line. */
const TRACE_TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/;

interface Seen { at: number; repeats: number }
const seen = new Map<string, Seen>();

export interface CodexStderrLogLine {
  level: "warn" | "debug";
  message: string;
  /** The redacted line, for the client's exit message. */
  text: string;
}

/** The short name of the login a CODEX_HOME belongs to, for log lines. */
export function codexLoginTag(codexHome: string | undefined): string {
  if (!codexHome) return "ambient";
  const parts = codexHome.split(/[\\/]/).filter(Boolean);
  return (parts[parts.length - 1] ?? "unknown").slice(0, 8);
}

/** Null for a line not worth logging at all. `account` comes from {@link codexLoginTag}. */
export function codexStderrLogLine(account: string, line: string, now = Date.now()): CodexStderrLogLine | null {
  const s = line.trim();
  if (!s || /warning|trace-warnings|circular dependency/i.test(s)) return null;
  // codex's stderr is Rust tracing ("<time> ERROR codex_x::y: …"), so its own level decides
  // ours: a failed cache write is not a PPM ERROR. An untagged line is `bun x` resolving
  // the package unless it reads like a failure.
  const tag = /^(?:\S+\s+)?(ERROR|WARN|INFO|DEBUG|TRACE)\b/.exec(s)?.[1];
  const loud = tag ? tag === "ERROR" || tag === "WARN" : /error|panic|fatal|fail/i.test(s);
  const text = redactTruncate(s, 200);
  const prefix = `stderr account=${account}: `;
  if (!loud) return { level: "debug", message: prefix + text, text };

  const key = `${account}\0${text.replace(TRACE_TIMESTAMP, "")}`;
  const prev = seen.get(key);
  if (prev && now - prev.at < REPEAT_WINDOW_MS) {
    prev.repeats++;
    return { level: "debug", message: prefix + text, text };
  }
  seen.delete(key);
  if (seen.size >= MAX_TRACKED) seen.delete(seen.keys().next().value!);
  seen.set(key, { at: now, repeats: 0 });
  const more = prev?.repeats
    ? ` (seen ${prev.repeats} more time${prev.repeats === 1 ? "" : "s"} since ${new Date(prev.at).toISOString()})`
    : "";
  return { level: "warn", message: prefix + text + more, text };
}

/** Test seam: forget which lines were already logged. */
export function _resetCodexStderrLogForTesting(): void {
  seen.clear();
}
