import type { ChatMessage, ChatEvent, SessionInfo } from "../provider.interface.ts";
import { stripSharedContext } from "../../shared/provider-context.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { redactTruncate } from "./codex-redact.ts";
import { parseApplyPatch, changeToToolUse } from "./codex-patch.ts";
import { mapRolloutItem } from "./codex-rollout-items.ts";
import { completeLines, parseLine, readRolloutHeader, type RolloutHeader } from "./codex-rollout-header.ts";
import {
  finalAssistantText, subagentToolResult, subagentToolUse, transcriptToEvents,
  type SubagentTranscript,
} from "./codex-subagent-thread.ts";

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

/** Normalize a path for cross-platform comparison (case-insensitive on win32). */
function normPath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
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

/** rollout `custom_tool_call` (apply_patch / custom tools) → PPM tool_use. */
function customToolCallToToolUse(p: Record<string, unknown>): ChatEvent {
  const callId = typeof p.call_id === "string" ? p.call_id : undefined;
  if (p.name === "apply_patch" && typeof p.input === "string") {
    const changes = parseApplyPatch(p.input);
    if (changes.length > 0) return changeToToolUse(changes[0]!, callId);
  }
  return { type: "tool_use", tool: String(p.name ?? "tool"), input: p.input ?? {}, toolUseId: callId };
}

/** Unknown `*_call` record → generic visible tool_use (never dropped). */
function genericCallToToolUse(p: Record<string, unknown>): ChatEvent {
  const callId = typeof p.call_id === "string" ? p.call_id : undefined;
  const tool = String(p.name ?? p.type ?? "tool");
  const input = p.input ?? safeParseArgs(p.arguments);
  return { type: "tool_use", tool, input, toolUseId: callId };
}

/** rollout `function_call_output` / `custom_tool_call_output` → PPM tool_result. */
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
export function parseRolloutJsonl(
  text: string,
  opts?: {
    preCompact?: boolean;
    /** Reads a spawned thread's transcript so its card can nest it. */
    loadSubagent?: (threadId: string) => SubagentTranscript | null;
  },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let i = 0;
  let pendingEvents: ChatEvent[] = [];
  // Kept so the completion can answer the card the spawn opened, with the
  // report the child ended on.
  const subagentTranscripts = new Map<string, SubagentTranscript | null>();

  // Newer codex records every finished step as an `item_completed` event AND
  // keeps the raw model exchange in `response_item` records. Both describe the
  // same tool calls, so taking both renders every command twice — and the
  // response_item copy of an image generation carries the whole PNG as base64,
  // which would land in the transcript. When the item events are present they
  // are the better source: already assembled, already named the way the live
  // stream names them.
  const hasItemEvents = text.includes('"item_completed"');

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
        messages.push({ id: `rollout-${i++}`, role: "user", content: stripSharedContext(p.message), timestamp: ts });
      } else if (p.type === "agent_message" && typeof p.message === "string") {
        flushAssistant(p.message, ts);
      } else if (p.type === "item_completed") {
        // Newer codex writes one item per finished step instead of the
        // user_message/agent_message pair above. Same conversation, different
        // spelling — see codex-rollout-items.
        const mapped = mapRolloutItem(p.item);
        if (mapped.kind === "user") {
          if (pendingEvents.length) flushAssistant("", ts);
          messages.push({ id: `rollout-${i++}`, role: "user", content: stripSharedContext(mapped.text), timestamp: ts });
        } else if (mapped.kind === "assistant") {
          flushAssistant(mapped.text, ts);
        } else if (mapped.kind === "events") {
          pendingEvents.push(...mapped.events);
        } else if (mapped.kind === "subagent") {
          const { activity } = mapped;
          if (!subagentTranscripts.has(activity.threadId)) {
            subagentTranscripts.set(activity.threadId, opts?.loadSubagent?.(activity.threadId) ?? null);
          }
          const transcript = subagentTranscripts.get(activity.threadId) ?? null;
          pendingEvents.push(activity.done
            ? subagentToolResult(activity, transcript)
            : subagentToolUse(activity, transcript));
        }
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
      if (hasItemEvents) continue; // item_completed already carried these
      if (p.type === "function_call") pendingEvents.push(fnCallToToolUse(p));
      else if (p.type === "function_call_output") pendingEvents.push(fnOutputToToolResult(p));
      // File edits are recorded as custom_tool_call (name=apply_patch) + output.
      else if (p.type === "custom_tool_call") pendingEvents.push(customToolCallToToolUse(p));
      else if (p.type === "custom_tool_call_output") pendingEvents.push(fnOutputToToolResult(p));
      // Exhaustive fallback: never silently drop an unknown tool call/output.
      else if (typeof p.type === "string" && p.type.endsWith("_call_output")) pendingEvents.push(fnOutputToToolResult(p));
      else if (typeof p.type === "string" && p.type.endsWith("_call")) pendingEvents.push(genericCallToToolUse(p));
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
        const rawContent = contentToText(item.content);
        const content = role === "user" ? stripSharedContext(rawContent) : rawContent;
        if (content) messages.push({ id: `rollout-${i++}`, role, content, timestamp: ts });
      }
    }
  }
  if (pendingEvents.length) flushAssistant("", messages[messages.length - 1]?.timestamp ?? new Date().toISOString());
  return messages;
}

/** Read a rollout file's header (session_meta, plus its title when asked). */
function readSessionMeta(file: string, opts?: { withTitle?: boolean }): RolloutHeader | null {
  try {
    return readRolloutHeader(readFileSync(file, "utf-8"), opts);
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
 *
 * A spawned subagent's rollout is excluded too. It carries the same cwd as the
 * conversation that spawned it, so cwd alone let one subagent per spawn into the
 * session list — each opening with no prompt and no ending, because a subagent's
 * task never appears in its own transcript. Its work shows in the parent, on the
 * Agent card for that spawn.
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
    const meta = readSessionMeta(file, { withTitle: true });
    if (!meta?.cwd) continue;            // fail-closed: no cwd → exclude
    if (normPath(meta.cwd) !== target) continue;
    if (meta.parentThreadId) continue;   // one step of another session, not a session

    const id = meta.id ?? threadIdFromName(file);
    if (!id) continue;

    let updatedAt = meta.timestamp;
    try { updatedAt = statSync(file).mtime.toISOString(); } catch { /* keep meta ts */ }

    sessions.push({
      id,
      providerId,
      title: meta.title ?? "Codex session",
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
  const files = findRolloutFiles(sessionsDir);
  // The filename carries the thread id, so try those first and read nothing for
  // the rest unless the name match is rejected. Reading a transcript to identify
  // it costs megabytes, and resolving one is now per spawned subagent too.
  const named = (f: string) => threadIdFromName(f) === threadId;
  for (const file of [...files.filter(named), ...files.filter((f) => !named(f))]) {
    const byName = named(file);
    const meta = byName && target == null ? null : readSessionMeta(file);
    if (!byName && meta?.id !== threadId) continue;
    if (target != null && (!meta?.cwd || normPath(meta.cwd) !== target)) continue; // fail-closed
    return file;
  }
  return null;
}

/**
 * Why a thread stopped, when it produced no message of its own.
 *
 * A subagent that dies on startup (a model its account cannot use, a transport
 * failure) writes a transcript with nothing in it but the error, so without this
 * its card in the parent is blank and says nothing about what went wrong.
 */
function terminalError(text: string): string {
  for (const line of completeLines(text).reverse()) {
    const rec = parseLine(line);
    if (rec?.type !== "event_msg") continue;
    const p = rec.payload ?? {};
    if (p.type !== "task_complete" && p.type !== "error") continue;
    const err = p.error;
    const message = typeof err === "string" ? err
      : (err && typeof err === "object" ? (err as Record<string, unknown>).message : undefined);
    if (typeof message === "string" && message) return unwrapErrorJson(message);
  }
  return "";
}

/** Codex nests the upstream API error verbatim, as JSON, inside its own message. */
function unwrapErrorJson(message: string): string {
  if (!message.startsWith("{")) return message;
  try {
    const inner = (JSON.parse(message) as { error?: { message?: unknown } }).error?.message;
    return typeof inner === "string" && inner ? inner : message;
  } catch { return message; }
}

/** How deep a chain of spawned agents is followed into the parent's transcript. */
const SUBAGENT_DEPTH = 2;

/**
 * Reader for a spawned thread's transcript, bound to the same sessions dir and
 * the same fail-closed cwd guard as the conversation that spawned it.
 *
 * `seen` covers both the cycle a malformed pair of rollouts could describe and
 * the same agent being named by its start and its completion.
 */
function subagentLoader(
  sessionsDir: string,
  requestedCwd: string | undefined,
  seen: Set<string>,
  depth: number,
): (threadId: string) => SubagentTranscript | null {
  return (threadId) => {
    if (depth <= 0 || seen.has(threadId)) return null;
    seen.add(threadId);
    const file = findRolloutByThreadId(sessionsDir, threadId, requestedCwd);
    if (!file) return null;
    try {
      const text = readFileSync(file, "utf-8");
      const msgs = parseRolloutJsonl(text, {
        loadSubagent: subagentLoader(sessionsDir, requestedCwd, seen, depth - 1),
      });
      const finalText = finalAssistantText(msgs) || terminalError(text);
      const events = transcriptToEvents(msgs);
      // An agent that died before saying anything is answered by its own error
      // record, and the parent may never have written a completion for it — so
      // the reason goes inside the card rather than waiting for a result event
      // that is not coming.
      if (events.length === 0 && finalText) events.push({ type: "text", content: finalText });
      return { events, finalText };
    } catch { return null; }
  };
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
    const msgs = parseRolloutJsonl(text, {
      loadSubagent: subagentLoader(sessionsDir, requestedCwd, new Set([threadId]), SUBAGENT_DEPTH),
    });
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

/** True when a path points at a codex rollout in the ambient or a PPM account home. */
export function isCodexRolloutPath(p: string): boolean {
  const n = normPath(p);
  const ambient = normPath(join(homedir(), ".codex", "sessions"));
  const managed = normPath(join(homedir(), ".ppm", "codex-accounts"));
  return n.endsWith(".jsonl") && (n.includes(ambient) || (n.includes(managed) && n.includes("/sessions/")));
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
