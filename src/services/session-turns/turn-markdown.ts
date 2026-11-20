/**
 * A whole chat as a Markdown document a person keeps: every turn under its own heading, what was
 * asked and what was answered in full, and one line per tool call — never thinking, never what a
 * tool printed (which is the bulk of a transcript and rarely what anyone wants to keep).
 *
 * Unlike `turn-render.ts`, which quotes turns to an AI as data, nothing here is fenced or cut: the
 * reader is the person who exported it.
 */
import { promptTextOf } from "../../shared/user-prompt-kind.ts";
import { decodeMessageBlocks } from "../../shared/chat-message-blocks.ts";
import type { ChatMessage } from "../../types/chat.ts";
import { COMPACTED_MARKER, type SessionTurnSummary } from "./session-turn-types.ts";
import { oneLine, resultsById, resultStatus, shortToolArg } from "./turn-render.ts";

export interface MarkdownSession {
  title: string;
  providerId: string;
  sessionId: string;
  projectName: string;
  exportedAt: string;
}

const PROVIDER_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

/** Inline code that survives backticks in its text. */
function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return fence + pad + text + pad + fence;
}

function assistantBlocks(msg: ChatMessage, results: ReturnType<typeof resultsById>): string[] {
  const top = (msg.events ?? []).filter((ev) => !("parentToolUseId" in ev && ev.parentToolUseId));
  if (!top.some((ev) => ev.type === "text" || ev.type === "tool_use")) return msg.content.trim() ? [msg.content.trim()] : [];
  const blocks: string[] = [];
  let prose = "";
  let calls: string[] = [];
  const flushProse = () => { if (prose.trim()) blocks.push(prose.trim()); prose = ""; };
  const flushCalls = () => { if (calls.length) blocks.push(calls.join("\n")); calls = []; };
  for (const ev of top) {
    if (ev.type === "text") { flushCalls(); prose += ev.content; }
    else if (ev.type === "tool_use") {
      flushProse();
      const arg = shortToolArg(ev.input);
      const status = resultStatus(ev.toolUseId ? results.get(ev.toolUseId) : undefined);
      calls.push("- " + code(oneLine(ev.tool, 80)) + (arg ? " " + code(arg) : "") + " · " + status);
    } else if (ev.type === "error") {
      flushProse();
      flushCalls();
      blocks.push("> Error: " + oneLine(ev.message, 300));
    }
  }
  flushProse();
  flushCalls();
  return blocks;
}

/** One turn: its heading, then each person's and the assistant's part. */
export function turnMarkdown(turn: SessionTurnSummary, messages: ChatMessage[], assistantName: string): string {
  const parts = ["## Turn " + turn.n + " · " + turn.startedAt];
  const results = resultsById(messages);
  let speaker: "user" | "assistant" | null = null;
  for (const msg of messages) {
    if (msg.synthetic) {
      if (msg.content === COMPACTED_MARKER) parts.push("*" + COMPACTED_MARKER + "*");
      continue;
    }
    if (msg.role === "user") {
      const prompt = promptTextOf(msg.content);
      if (prompt === null) continue;
      parts.push("**You**", decodeMessageBlocks(prompt).content.trim() || prompt.trim());
      speaker = "user";
    } else if (msg.role === "assistant") {
      const blocks = assistantBlocks(msg, results);
      if (!blocks.length) continue;
      if (speaker !== "assistant") parts.push("**" + assistantName + "**");
      parts.push(...blocks);
      speaker = "assistant";
    }
  }
  if (turn.status === "running") parts.push("*(turn still running when exported)*");
  return parts.join("\n\n");
}

/** The document: a title, one line saying what it is, then every turn. */
export function sessionMarkdown(session: MarkdownSession, turns: Array<{ turn: SessionTurnSummary; messages: ChatMessage[] }>): string {
  const name = PROVIDER_NAMES[session.providerId] ?? session.providerId;
  const head = [
    "# " + (oneLine(session.title, 200) || "Chat " + session.sessionId),
    "*" + name + " chat in " + session.projectName + " · session " + session.sessionId + " · " + turns.length + (turns.length === 1 ? " turn" : " turns") + " · exported " + session.exportedAt + "*",
  ].join("\n\n");
  return [head, ...turns.map((t) => turnMarkdown(t.turn, t.messages, name))].join("\n\n---\n\n") + "\n";
}

/** A file name for the export: the title's words, safe on every OS. */
export function exportFileName(title: string, sessionId: string): string {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return (slug || "chat-" + sessionId.slice(0, 8)) + ".md";
}
