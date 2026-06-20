import type { ChatMessage, ChatEvent, SessionInfo } from "../provider.interface.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { redactTruncate } from "./codex-redact.ts";

/**
 * Independent parser for Codex rollout JSONL transcripts
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`).
 *
 * The rollout schema is NOT the app-server ThreadItem union — each line is
 * `{ type, payload: { type, ... } }` with payload.type ∈
 * session_meta | event_msg | response_item | turn_context. We reconstruct the
 * user/assistant transcript from the clean `event_msg` user_message /
 * agent_message records (response_item duplicates + carries developer/system
 * scaffolding).
 */

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** Normalize a path for cross-platform comparison (case-insensitive on win32). */
function normPath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** Split into complete, newline-terminated lines only (drop a trailing partial). */
function completeLines(text: string): string[] {
  const lines = text.split("\n");
  // If the text does not end in a newline, the last element is a partial line.
  if (!text.endsWith("\n")) lines.pop();
  return lines.filter((l) => l.trim() !== "");
}

function parseLine(line: string): RolloutLine | null {
  try { return JSON.parse(line) as RolloutLine; } catch { return null; }
}

/** Extract plain text from a response_item message content array. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as any).text === "string" ? (c as any).text : ""))
    .filter(Boolean)
    .join("");
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") { try { return JSON.parse(raw); } catch { return {}; } }
  return {};
}

/** rollout `function_call` (OpenAI Responses format) → PPM tool_use. */
function fnCallToToolUse(p: Record<string, unknown>): ChatEvent {
  const args = safeParseArgs(p.arguments);
  const command = typeof args.command === "string" ? args.command : "";
  const callId = typeof p.call_id === "string" ? p.call_id : undefined;
  if (p.name === "shell_command" || command) {
    const tool = /powershell|pwsh/i.test(command) ? "PowerShell" : "Bash";
    return { type: "tool_use", tool, input: { command, cwd: args.workdir }, toolUseId: callId };
  }
  return { type: "tool_use", tool: String(p.name ?? "tool"), input: args, toolUseId: callId };
}

/** rollout `function_call_output` → PPM tool_result (exit-code → isError). */
function fnOutputToToolResult(p: Record<string, unknown>): ChatEvent {
  const output = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
  const m = /exit code:\s*(\d+)/i.exec(output);
  return {
    type: "tool_result",
    output: redactTruncate(output),
    isError: m ? m[1] !== "0" : false,
    toolUseId: typeof p.call_id === "string" ? p.call_id : undefined,
  };
}

/**
 * Parse rollout JSONL text → ordered ChatMessage[]. Never throws.
 * Text turns come from clean `event_msg` user_message/agent_message records;
 * tool calls come from `response_item` function_call / function_call_output and
 * are nested into the assistant turn's `events` so the chat UI renders tool cards.
 */
export function parseRolloutJsonl(text: string, opts?: { preCompact?: boolean }): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let i = 0;
  let pendingEvents: ChatEvent[] = [];

  const flushAssistant = (content: string, ts: string) => {
    if (!content && pendingEvents.length === 0) return;
    const events = pendingEvents.length
      ? [...pendingEvents, ...(content ? [{ type: "text", content } as ChatEvent] : [])]
      : undefined;
    messages.push({ id: `rollout-${i++}`, role: "assistant", content, ...(events ? { events } : {}), timestamp: ts });
    pendingEvents = [];
  };

  for (const line of completeLines(text)) {
    const rec = parseLine(line);
    if (!rec) continue;
    const p = rec.payload ?? {};
    const ts = rec.timestamp ?? new Date().toISOString();

    if (rec.type === "event_msg") {
      if (p.type === "user_message" && typeof p.message === "string") {
        if (pendingEvents.length) flushAssistant("", ts); // tools with no final text
        messages.push({ id: `rollout-${i++}`, role: "user", content: p.message, timestamp: ts });
      } else if (p.type === "agent_message" && typeof p.message === "string") {
        flushAssistant(p.message, ts);
      } else if (p.type === "thread_rolled_back") {
        // codex doesn't truncate the rollout file on rollback/fork — it appends this
        // marker. Drop the last `num_turns` turns (by user-message turn-start) so a
        // forked/rewound thread renders its real (post-rollback) history.
        const n = typeof p.num_turns === "number" ? p.num_turns : 0;
        if (n > 0) {
          pendingEvents = [];
          const userIdxs: number[] = [];
          for (let j = 0; j < messages.length; j++) if (messages[j]!.role === "user") userIdxs.push(j);
          messages.length = n >= userIdxs.length ? 0 : userIdxs[userIdxs.length - n]!;
        }
      }
    } else if (rec.type === "response_item") {
      if (p.type === "function_call") pendingEvents.push(fnCallToToolUse(p));
      else if (p.type === "function_call_output") pendingEvents.push(fnOutputToToolResult(p));
    } else if (rec.type === "compacted") {
      // Pre-compact mode: everything accumulated so far IS the pre-compact history.
      if (opts?.preCompact) { if (pendingEvents.length) flushAssistant("", ts); break; }
      // In-place compaction: `replacement_history` REPLACES everything before this
      // point. Reset to the post-compact base; turns after it append normally.
      pendingEvents = [];
      messages.length = 0;
      const rh = Array.isArray(p.replacement_history) ? p.replacement_history : [];
      for (const it of rh) {
        if (!it || typeof it !== "object") continue;
        const item = it as Record<string, unknown>;
        if (item.type !== "message") continue;
        const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
        if (!role) continue;
        const content = contentToText(item.content);
        if (content) messages.push({ id: `rollout-${i++}`, role, content, timestamp: ts });
      }
    }
  }
  if (pendingEvents.length) flushAssistant("", messages[messages.length - 1]?.timestamp ?? new Date().toISOString());
  return messages;
}

/** Read the session_meta header (first record) from a rollout file. */
function readSessionMeta(file: string): { id?: string; cwd?: string; timestamp?: string } | null {
  try {
    const text = readFileSync(file, "utf-8");
    for (const line of completeLines(text)) {
      const rec = parseLine(line);
      if (rec?.type === "session_meta") {
        const p = rec.payload ?? {};
        return {
          id: typeof p.id === "string" ? p.id : undefined,
          cwd: typeof p.cwd === "string" ? p.cwd : undefined,
          timestamp: typeof p.timestamp === "string" ? p.timestamp : rec.timestamp,
        };
      }
    }
  } catch { /* unreadable file → excluded (fail-closed) */ }
  return null;
}

/** Recursively collect rollout-*.jsonl files under a sessions dir. */
function findRolloutFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...findRolloutFiles(full));
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(full);
  }
  return out;
}

function threadIdFromName(file: string): string | null {
  const m = file.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return m?.[1] ?? null;
}

/**
 * List codex rollout sessions for a specific project dir. FAIL-CLOSED: a rollout
 * is included ONLY when its session_meta cwd resolves and matches `requestedCwd`
 * (normalized; case-insensitive on win32). Unattributable rollouts are excluded
 * — `~/.codex/sessions` holds every project's transcripts.
 */
export function listCodexRollouts(
  sessionsDir: string,
  requestedCwd: string,
  providerId: string,
  opts?: { limit?: number; offset?: number },
): SessionInfo[] {
  const target = normPath(requestedCwd);
  const files = findRolloutFiles(sessionsDir);
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    const meta = readSessionMeta(file);
    if (!meta?.cwd) continue;            // fail-closed: no cwd → exclude
    if (normPath(meta.cwd) !== target) continue;

    const id = meta.id ?? threadIdFromName(file);
    if (!id) continue;

    let updatedAt = meta.timestamp;
    try { updatedAt = statSync(file).mtime.toISOString(); } catch { /* keep meta ts */ }

    sessions.push({
      id,
      providerId,
      title: "Codex session",
      createdAt: meta.timestamp ?? new Date().toISOString(),
      updatedAt,
    });
  }

  sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? sessions.length;
  return sessions.slice(offset, offset + limit);
}

/**
 * Locate the rollout file for a thread id within a sessions dir. Match is
 * ANCHORED on the structured `session_meta.id` or the filename's trailing UUID
 * (never a loose substring). When `requestedCwd` is given the match is also
 * FAIL-CLOSED on cwd — a rollout whose cwd is missing/unresolvable or != the
 * requested dir is never returned (cross-project disclosure guard).
 */
export function findRolloutByThreadId(sessionsDir: string, threadId: string, requestedCwd?: string): string | null {
  const target = requestedCwd != null ? normPath(requestedCwd) : null;
  for (const file of findRolloutFiles(sessionsDir)) {
    if (threadIdFromName(file) !== threadId) {
      const meta = readSessionMeta(file);
      if (meta?.id !== threadId) continue;
    }
    if (target != null) {
      const meta = readSessionMeta(file);
      if (!meta?.cwd || normPath(meta.cwd) !== target) continue; // fail-closed
    }
    return file;
  }
  return null;
}

/** The compaction summary text if this rollout was compacted, else null. */
function compactionSummary(text: string): string | null {
  for (const line of completeLines(text)) {
    const rec = parseLine(line);
    if (rec?.type === "compacted") {
      const msg = (rec.payload as Record<string, unknown> | undefined)?.message;
      return typeof msg === "string" ? msg : "";
    }
  }
  return null;
}

/**
 * Read + parse a thread's transcript from disk (post-compact view). `requestedCwd`
 * enforces the fail-closed cwd guard. When the thread was compacted, prepend a
 * compact-summary message carrying the `read the full transcript at: <file>` marker
 * the chat UI uses to offer "load more" (→ GET /chat/pre-compact-messages).
 */
export function getRolloutMessages(sessionsDir: string, threadId: string, requestedCwd?: string): ChatMessage[] {
  const file = findRolloutByThreadId(sessionsDir, threadId, requestedCwd);
  if (!file) return [];
  try {
    const text = readFileSync(file, "utf-8");
    const msgs = parseRolloutJsonl(text);
    const summary = compactionSummary(text);
    if (summary !== null) {
      msgs.unshift({
        id: `codex-compact-${threadId}`,
        role: "assistant",
        content: `${summary || "_Earlier conversation was compacted to save context._"}\n\nread the full transcript at: ${file}`,
        timestamp: new Date().toISOString(),
      });
    }
    return msgs;
  } catch { return []; }
}

/** True when a path points at a codex rollout under ~/.codex/sessions. */
export function isCodexRolloutPath(p: string): boolean {
  const n = normPath(p);
  return n.endsWith(".jsonl") && n.includes(normPath(join(homedir(), ".codex", "sessions")));
}

/**
 * Pre-compact slice for the "load more" feature. Jails to ~/.codex/sessions,
 * fail-closed on cwd, returns the messages BEFORE the compaction boundary.
 */
export function getCodexPreCompactMessages(file: string, requestedCwd?: string): ChatMessage[] {
  if (!isCodexRolloutPath(file)) throw new Error("Access denied: not a codex rollout");
  const resolved = resolve(file);
  let text: string;
  try { text = readFileSync(resolved, "utf-8"); } catch { throw new Error("File not found"); }
  if (requestedCwd != null) {
    const meta = readSessionMeta(resolved);
    if (!meta?.cwd || normPath(meta.cwd) !== normPath(requestedCwd)) return []; // fail-closed
  }
  return parseRolloutJsonl(text, { preCompact: true });
}
