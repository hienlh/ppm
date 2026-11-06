/**
 * The turns of a chat session — each prompt the user sent and everything the agent did for it —
 * with the ids of the calls each one made. A block of the Review tab names the calls that wrote
 * it (`SessionBlockSummary.calls`); this is what turns those into "Turn 3 · 14:02".
 *
 * A turn's number is the server's (`ChatMessage.turnN`, counted from the session's first prompt,
 * compactions included), so the chat, the Review tab and a turn link all say the same number, and
 * loading an older segment back in moves none of them. A prompt the server has not numbered yet —
 * one sent in this tab, before the history is fetched again — takes the number after the turn
 * before it. History the server could not number at all (its turn index failed to read) carries no
 * `turnN` anywhere; unless the list is known to start at the session's first prompt, counting
 * its prompts from 1 would only number what happens to be loaded, so those turns are marked
 * `unnumbered` and labelled without a number.
 *
 * Pure, and cached per message object like `aggregate-turn-file-changes.ts`: the chat replaces a
 * message whenever anything in it changes, so while it streams only the newest one is walked.
 */
import type { ChatEvent, ChatMessage } from "../../types/chat";
import { isRealPromptMessage, promptTextOf } from "../../shared/user-prompt-kind";

export interface SessionTurn {
  /** 1-based from the session's first prompt; only relative to the loaded list when `unnumbered`. */
  n: number;
  /** The server numbered none of the loaded history, so `n` is no number to show. */
  unnumbered?: boolean;
  /** The server's id for the turn, once it has one. */
  turnId?: string;
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

/**
 * What the user typed, or null for a user message that is not a prompt (a tool result, injected
 * context). The decision is the server turn index's own (`shared/user-prompt-kind.ts`).
 */
function promptOf(msg: ChatMessage): string | null {
  if (promptCache.has(msg)) return promptCache.get(msg)!;
  const prompt = isRealPromptMessage(msg) ? promptTextOf(msg.content) : null;
  promptCache.set(msg, prompt);
  return prompt;
}

export function sessionTurns(
  messages: readonly ChatMessage[],
  /** `fromStart`: the list holds the session from its first prompt, so counting from 1 is right. */
  { fromStart = true }: { fromStart?: boolean } = {},
): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let turn: SessionTurn | null = null;
  // Whether anything the server numbered is loaded, and whether any prompt came from history
  // (one this tab sent carries its `clientId`, and is numbered from the turns before it).
  let stamped = false;
  let fromHistory = false;
  for (const msg of messages) {
    if (msg.turnN !== undefined) stamped = true;
    const prompt = promptOf(msg);
    if (prompt !== null && !msg.clientId) fromHistory = true;
    // A message steered into a running Codex turn reads as a prompt but is part of that turn.
    if (prompt !== null && !(turn && msg.turnId && msg.turnId === turn.turnId)) {
      const previous: SessionTurn | null = turn;
      const n: number = msg.turnN ?? (previous ? previous.n + 1 : 1);
      turn = { n, ...(msg.turnId ? { turnId: msg.turnId } : {}), messageId: msg.id, at: msg.timestamp, prompt, calls: [] };
      turns.push(turn);
    } else if (turn && msg.role === "assistant") {
      turn.calls.push(...callsOf(msg));
    }
  }
  if (!stamped && fromHistory && !fromStart) for (const t of turns) t.unnumbered = true;
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

/** "Turn 3", or just "Turn" when the server could not number it. */
export function turnLabel(turn: Pick<SessionTurn, "n" | "unnumbered">): string {
  return turn.unnumbered ? "Turn" : `Turn ${turn.n}`;
}

/** "14:02" for today, "Oct 1, 14:02" before it. */
export function turnTime(at: string, now = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
