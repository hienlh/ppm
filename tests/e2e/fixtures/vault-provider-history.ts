/**
 * The vault canary's scripted providers keep their chats' history where the real CLIs keep it and
 * in the CLIs' own record shapes, because that is what PPM's transcript redactor rewrites and what
 * the chat's history is read back from:
 *
 * - "claude": `<home>/.claude/projects/<slug>/<session>.jsonl`, one record per content block as
 *   Claude Code writes them — a `user` prompt, an `assistant` record per text or `tool_use` block,
 *   a `user` record carrying the `tool_result` (and `toolUseResult`) — each with its `uuid` and the
 *   `parentUuid` of the record before it.
 * - "codex": `<home>/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`, a `session_meta`
 *   first line, then `response_item` records (message, function_call, function_call_output) with
 *   the matching `event_msg` user/agent messages.
 *
 * `<home>` is the process's home, which the fixture has already checked is the sandbox's.
 * `readHistory` turns the file back into the chat's messages, so whatever PPM rewrote in it is what
 * the chat shows on reopening.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ChatEvent = import("../../../src/providers/provider.interface").ChatEvent;
type ChatMessage = import("../../../src/providers/provider.interface").ChatMessage;

export interface HistorySession { id: string; providerId: string; projectPath?: string; createdAt: string }

export const claudeSlug = (projectPath: string) => projectPath.replace(/[/\\:.]/g, "-");
export const claudeTranscriptPath = (s: HistorySession) => join(homedir(), ".claude", "projects", claudeSlug(s.projectPath ?? ""), `${s.id}.jsonl`);
const codexSessionsRoot = () => join(homedir(), ".codex", "sessions");

function findFiles(dir: string, test: (name: string) => boolean): string[] {
  const out: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, test));
    else if (test(e.name)) out.push(p);
  }
  return out;
}

/** The session's rollout, if one was written (found by the thread id its name ends with). */
export function codexRolloutPath(s: HistorySession): string | null {
  return findFiles(codexSessionsRoot(), (n) => n.startsWith("rollout-") && n.endsWith(`${s.id}.jsonl`))[0] ?? null;
}

const lines = (path: string | null): Array<Record<string, unknown>> => {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
  });
};

/** Appends one turn's records as the session's CLI would. */
export interface HistoryWriter {
  user(text: string): void;
  toolUse(name: string, input: Record<string, unknown>, id: string): void;
  toolResult(id: string, text: string, isError: boolean): void;
  text(text: string): void;
}

export function historyWriter(s: HistorySession): HistoryWriter {
  const now = () => new Date().toISOString();
  if (s.providerId === "codex") {
    let path = codexRolloutPath(s);
    if (!path) {
      const t = new Date();
      const day = [String(t.getUTCFullYear()), String(t.getUTCMonth() + 1).padStart(2, "0"), String(t.getUTCDate()).padStart(2, "0")];
      const dir = join(codexSessionsRoot(), ...day);
      mkdirSync(dir, { recursive: true });
      path = join(dir, `rollout-${t.toISOString().slice(0, 19).replace(/:/g, "-")}-${s.id}.jsonl`);
      appendFileSync(path, `${JSON.stringify({
        timestamp: now(), type: "session_meta",
        payload: { id: s.id, timestamp: s.createdAt, cwd: s.projectPath, originator: "codex_cli_rs", cli_version: "0.150.0", instructions: null },
      })}\n`);
    }
    const file = path;
    const put = (type: string, payload: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify({ timestamp: now(), type, payload })}\n`);
    return {
      user: (text) => {
        put("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
        put("event_msg", { type: "user_message", message: text, images: [] });
      },
      toolUse: (name, input, id) => put("response_item", { type: "function_call", name, arguments: JSON.stringify(input), call_id: id }),
      toolResult: (id, text, isError) => put("response_item", {
        type: "function_call_output", call_id: id, output: JSON.stringify({ content: [{ type: "text", text }], isError }),
      }),
      text: (text) => {
        put("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
        put("event_msg", { type: "agent_message", message: text });
      },
    };
  }

  const file = claudeTranscriptPath(s);
  mkdirSync(join(file, ".."), { recursive: true });
  let parent = (lines(file).at(-1)?.uuid as string | undefined) ?? null;
  const put = (type: "user" | "assistant", message: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const uuid = crypto.randomUUID();
    appendFileSync(file, `${JSON.stringify({
      parentUuid: parent, isSidechain: false, userType: "external", cwd: s.projectPath, sessionId: s.id, version: "2.1.280",
      gitBranch: "", type, message, ...extra, uuid, timestamp: now(),
    })}\n`);
    parent = uuid;
  };
  const assistant = (content: unknown[], stop: string) => put("assistant", {
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model: "claude-opus-5",
    content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  }, { requestId: `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}` });
  return {
    user: (text) => put("user", { role: "user", content: text }),
    toolUse: (name, input, id) => assistant([{ type: "tool_use", id, name, input }], "tool_use"),
    toolResult: (id, text, isError) => put("user", {
      role: "user", content: [{ tool_use_id: id, type: "tool_result", content: [{ type: "text", text }], ...(isError ? { is_error: true } : {}) }],
    }, { toolUseResult: [{ type: "text", text }] }),
    text: (text) => assistant([{ type: "text", text }], "end_turn"),
  };
}

/** The chat's messages as the history file holds them now. */
export function readHistory(s: HistorySession, codexTool: (name: string, input: Record<string, unknown>) => { tool: string; input: unknown }): ChatMessage[] {
  const out: ChatMessage[] = [];
  let reply: (ChatMessage & { events: ChatEvent[] }) | null = null;
  const replyAt = (ts: string, id: string) => {
    if (!reply) {
      reply = { id, role: "assistant", content: "", events: [], timestamp: ts } as ChatMessage & { events: ChatEvent[] };
      out.push(reply);
    }
    return reply;
  };
  const say = (ts: string, id: string, text: string) => {
    const r = replyAt(ts, id);
    r.content = r.content ? `${r.content}\n\n${text}` : text;
    r.events.push({ type: "text", content: text } as ChatEvent);
  };
  if (s.providerId === "codex") {
    lines(codexRolloutPath(s)).forEach((rec, i) => {
      const ts = String(rec.timestamp ?? "");
      const p = (rec.payload ?? {}) as Record<string, unknown>;
      if (rec.type !== "response_item") return;
      if (p.type === "message" && p.role === "user") {
        reply = null;
        out.push({ id: `rollout-${i}`, role: "user", content: String((p.content as Array<{ text: string }>)[0]?.text ?? ""), timestamp: ts });
      } else if (p.type === "message" && p.role === "assistant") {
        say(ts, `rollout-${i}`, String((p.content as Array<{ text: string }>)[0]?.text ?? ""));
      } else if (p.type === "function_call") {
        const named = codexTool(String(p.name), JSON.parse(String(p.arguments ?? "{}")) as Record<string, unknown>);
        replyAt(ts, `rollout-${i}`).events!.push({ type: "tool_use", ...named, toolUseId: String(p.call_id) } as ChatEvent);
      } else if (p.type === "function_call_output") {
        const r = JSON.parse(String(p.output ?? "{}")) as { content?: Array<{ text: string }>; isError?: boolean };
        replyAt(ts, `rollout-${i}`).events!.push({ type: "tool_result", output: JSON.stringify(r.content ?? []), isError: !!r.isError, toolUseId: String(p.call_id) } as ChatEvent);
      }
    });
    return out;
  }
  for (const rec of lines(claudeTranscriptPath(s))) {
    const ts = String(rec.timestamp ?? "");
    const id = String(rec.uuid ?? "");
    const message = (rec.message ?? {}) as { content?: unknown };
    if (rec.type === "user" && typeof message.content === "string") {
      reply = null;
      out.push({ id, role: "user", content: message.content, timestamp: ts });
      continue;
    }
    for (const block of Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []) {
      if (block.type === "text") say(ts, id, String(block.text));
      else if (block.type === "tool_use") replyAt(ts, id).events!.push({ type: "tool_use", tool: block.name, input: block.input, toolUseId: block.id } as ChatEvent);
      else if (block.type === "tool_result") {
        replyAt(ts, id).events!.push({ type: "tool_result", output: JSON.stringify(block.content), isError: block.is_error === true, toolUseId: block.tool_use_id } as ChatEvent);
      }
    }
  }
  return out;
}
