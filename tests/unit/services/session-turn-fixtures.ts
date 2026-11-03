/**
 * Synthetic transcripts for the turn index tests, in the record shapes Claude Code and codex write
 * (key order included: the Claude scanner reads an assistant record's uuid from the line's tail).
 * No real conversation content.
 */
import { randomUUID } from "node:crypto";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
let clock = 0;
const ts = () => new Date(T0 + (clock++) * 1000).toISOString();

const claudeBase = { userType: "external", entrypoint: "sdk-ts", cwd: "/tmp/proj", sessionId: "s", version: "2.1.0", gitBranch: "main" };

export const claude = {
  prompt(text: string, promptId: string | null, uuid = randomUUID()): string {
    return JSON.stringify({
      parentUuid: null, isSidechain: false, ...(promptId ? { promptId } : {}), type: "user",
      message: { role: "user", content: text }, uuid, timestamp: ts(),
      permissionMode: "bypassPermissions", promptSource: "sdk", turnOrigin: "sdk", ...claudeBase,
    });
  },
  assistant(text: string, uuid = randomUUID(), toolInput?: unknown): string {
    const content = toolInput === undefined
      ? [{ type: "text", text }]
      : [{ type: "tool_use", id: `toolu_${uuid.slice(0, 8)}`, name: "Write", input: toolInput }];
    return JSON.stringify({
      parentUuid: null, isSidechain: false,
      message: { model: "claude-test", id: `msg_${uuid.slice(0, 8)}`, type: "message", role: "assistant", content },
      requestId: "req_1", type: "assistant", uuid, timestamp: ts(), ...claudeBase,
    });
  },
  toolResult(promptId: string, uuid = randomUUID(), output = "ok"): string {
    return JSON.stringify({
      parentUuid: null, isSidechain: false, promptId, type: "user",
      message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: output }] },
      uuid, timestamp: ts(), toolUseResult: { stdout: "ok" }, ...claudeBase,
    });
  },
  /** A task notification — the CLI often stamps the *next* prompt's id on it. */
  taskNotification(promptId: string, uuid = randomUUID()): string {
    return JSON.stringify({
      parentUuid: null, isSidechain: false, promptId, type: "user",
      message: { role: "user", content: "<task-notification><task-id>b1</task-id><status>completed</status></task-notification>" },
      uuid, timestamp: ts(), promptSource: "system", turnOrigin: "task_notification", origin: { kind: "task-notification" }, ...claudeBase,
    });
  },
  metaContinue(promptId: string, uuid = randomUUID()): string {
    return JSON.stringify({
      parentUuid: null, isSidechain: false, promptId, type: "user",
      message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] },
      isMeta: true, uuid, timestamp: ts(), ...claudeBase,
    });
  },
  compactSummary(promptId: string, uuid = randomUUID()): string {
    return JSON.stringify({
      parentUuid: null, isSidechain: false, promptId, type: "user",
      message: { role: "user", content: "This session is being continued from a previous conversation." },
      isVisibleInTranscriptOnly: true, isCompactSummary: true, uuid, timestamp: ts(), ...claudeBase,
    });
  },
  compactBoundary(): string {
    return JSON.stringify({ parentUuid: null, type: "system", subtype: "compact_boundary", content: "Conversation compacted", uuid: randomUUID(), timestamp: ts(), compactMetadata: { trigger: "auto", preTokens: 1000 } });
  },
  /** A CLI-local slash command: no promptId at all. */
  localCommand(name: string, uuid = randomUUID()): string {
    return JSON.stringify({
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `<command-name>${name}</command-name>\n<command-message>${name.slice(1)}</command-message>` },
      uuid, timestamp: ts(), ...claudeBase,
    });
  },
  localStdout(uuid = randomUUID()): string {
    return JSON.stringify({
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: "<local-command-stdout>Done</local-command-stdout>" }, uuid, timestamp: ts(), ...claudeBase,
    });
  },
  attachment(): string {
    return JSON.stringify({ type: "attachment", attachment: { type: "skill_listing" }, uuid: randomUUID(), timestamp: ts() });
  },
};

const ev = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: ts(), type: "event_msg", payload });

export const codex = {
  meta(id: string, cwd: string): string {
    return JSON.stringify({ timestamp: ts(), type: "session_meta", payload: { id, timestamp: ts(), cwd, originator: "codex_cli_rs", cli_version: "0.150.0" } });
  },
  taskStarted: (turnId: string) => ev({ type: "task_started", turn_id: turnId, started_at: 0 }),
  taskComplete: (turnId: string) => ev({ type: "task_complete", turn_id: turnId, last_agent_message: null }),
  turnAborted: (turnId: string) => ev({ type: "turn_aborted", turn_id: turnId, reason: "interrupted" }),
  user: (message: string) => ev({ type: "user_message", message, images: [] }),
  agent: (message: string) => ev({ type: "agent_message", message }),
  itemUser: (text: string, turnId: string) => ev({ type: "item_completed", turn_id: turnId, item: { type: "UserMessage", id: randomUUID(), content: [{ type: "text", text }] } }),
  itemAgent: (text: string, turnId: string) => ev({ type: "item_completed", turn_id: turnId, item: { type: "AgentMessage", id: randomUUID(), content: [{ type: "Text", text }] } }),
  call: (name: string) => JSON.stringify({ timestamp: ts(), type: "response_item", payload: { type: "function_call", name, arguments: "{\"command\":\"ls\"}", call_id: `call_${randomUUID().slice(0, 6)}` } }),
  rolledBack: (n: number) => ev({ type: "thread_rolled_back", num_turns: n }),
  compacted(history: Array<{ role: "user" | "assistant"; text: string }>): string {
    return JSON.stringify({
      timestamp: ts(), type: "compacted",
      payload: { message: "summary of the thread", replacement_history: history.map((h) => ({ type: "message", role: h.role, content: [{ type: h.role === "user" ? "input_text" : "output_text", text: h.text }] })) },
    });
  },
  tokenCount: () => ev({ type: "token_count", info: null }),
};

export const lines = (...records: string[]): string => records.map((r) => `${r}\n`).join("");
