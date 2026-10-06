/**
 * The turns of a chat session — each prompt the user sent and everything the agent did for it —
 * with the ids of the calls each one made. A block of the Review tab names the calls that wrote
 * it (`SessionBlockSummary.calls`); this is what turns those into "Turn 3 · 14:02".
 *
 * Turns are numbered from the session's last compaction on, the way the conversation reads after
 * it. A turn from before that boundary is "earlier" (`n` 0), not given a number that would move
 * each time the chat loads an older segment back in.
 *
 * Pure, and cached per message object like `aggregate-turn-file-changes.ts`: the chat replaces a
 * message whenever anything in it changes, so while it streams only the newest one is walked.
 */
import type { ChatEvent, ChatMessage } from "../../types/chat";
import { parseUserMessage, toComposerDraft } from "../components/chat/user-message-parse";

export interface SessionTurn {
  /** 1-based from the session's last compaction on; 0 for a turn from before it. */
  n: number;
  /** The user message that asked for it. */
  messageId: string;
  /** When it was asked (ISO). */
  at: string;
  /** What the user typed. */
  prompt: string;
  /** Every call the turn made, its sub-agents' included, in the order they appear. */
  calls: string[];
}

const callsCache = new WeakMap<ChatMessage, string[]>();

/**
 * Every call in a message. A sub-agent's card keeps only some of its steps as `children` once it
 * is slimmed (`slimAgentChildren`), but it keeps every step's id in `stepIds`, so both are read.
 */
function callsOf(msg: ChatMessage): string[] {
  const cached = callsCache.get(msg);
  if (cached) return cached;
  const out = new Set<string>();
  const visit = (events: ChatEvent[] | undefined) => {
    for (const ev of events ?? []) {
      if (ev.type !== "tool_use") continue;
      if (ev.toolUseId) out.add(ev.toolUseId);
      for (const id of ev.stepIds ?? []) if (!id.startsWith("idx:")) out.add(id);
      visit(ev.children);
    }
  };
  visit(msg.events);
  const calls = [...out];
  callsCache.set(msg, calls);
  return calls;
}

const promptCache = new WeakMap<ChatMessage, string | null>();

/** What the user typed, or null for a user message that is not a prompt (a tool result, injected context). */
function promptOf(msg: ChatMessage): string | null {
  if (promptCache.has(msg)) return promptCache.get(msg)!;
  let prompt: string | null = null;
  if (msg.role === "user" && !msg.compaction && msg.content.trim()) {
    const parsed = parseUserMessage(msg.content);
    if (parsed.text || parsed.command || parsed.files.length || parsed.terminalBlocks.length) {
      prompt =
        toComposerDraft(msg.content).text ||
        parsed.terminalBlocks.join("\n\n") ||
        `${parsed.files.length} attached file${parsed.files.length === 1 ? "" : "s"}`;
    }
  }
  promptCache.set(msg, prompt);
  return prompt;
}

export function sessionTurns(messages: readonly ChatMessage[]): SessionTurn[] {
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.compaction) {
      boundary = i;
      break;
    }
  }
  const turns: SessionTurn[] = [];
  let n = 0;
  let turn: SessionTurn | null = null;
  messages.forEach((msg, i) => {
    const prompt = promptOf(msg);
    if (prompt !== null) {
      turn = { n: i > boundary ? ++n : 0, messageId: msg.id, at: msg.timestamp, prompt, calls: [] };
      turns.push(turn);
    } else if (turn && msg.role === "assistant") {
      turn.calls.push(...callsOf(msg));
    }
  });
  return turns;
}

/** Each call's turn. */
export function turnsByCall(turns: readonly SessionTurn[]): Map<string, SessionTurn> {
  const out = new Map<string, SessionTurn>();
  for (const turn of turns) for (const call of turn.calls) out.set(call, turn);
  return out;
}

/** The turns `calls` belong to, oldest first, each once; calls of no known turn are left out. */
export function turnsOf(calls: readonly string[] | undefined, byCall: ReadonlyMap<string, SessionTurn>): SessionTurn[] {
  const out: SessionTurn[] = [];
  for (const call of calls ?? []) {
    const turn = byCall.get(call);
    if (turn && !out.includes(turn)) out.push(turn);
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** "Turn 3", or "Earlier turn" for one from before the last compaction. */
export function turnLabel(turn: Pick<SessionTurn, "n">): string {
  return turn.n > 0 ? `Turn ${turn.n}` : "Earlier turn";
}

/** "14:02" for today, "Oct 1, 14:02" before it. */
export function turnTime(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
