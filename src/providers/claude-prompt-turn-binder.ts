/**
 * Which browser message each Claude turn was opened by.
 *
 * The CLI's `UserPromptSubmit` hook fires once per prompt it starts a turn for, in streaming-input
 * mode too, and its `prompt_id` is the `promptId` the transcript records on that prompt — the turn
 * id the turn index uses (verified against a live CLI, a queued follow-up included). What the hook
 * does not carry is which of PPM's pushed messages it is about, and a message queued behind a
 * running turn is submitted long after it was pushed. So every push is remembered with its text and
 * the browser's id, and the hook's `prompt` text picks the oldest pending push that matches it.
 *
 * Prompts no browser sent — a task notification, the CLI's own continuation, PPM's retry nudge —
 * match nothing and announce nothing.
 */
import { stripSharedContext } from "../shared/provider-context.ts";
import { TURN_ID_RE } from "../services/session-turns/session-turn-types.ts";

interface PendingPrompt {
  text: string;
  clientMessageId?: string;
}

/** Pushes remembered per session; old ones beyond this are dropped unbound. */
const MAX_PENDING = 32;

function normalize(text: string): string {
  return stripSharedContext(text).trim();
}

export class PromptTurnBinder {
  private readonly pending = new Map<string, PendingPrompt[]>();

  /** A message was pushed to the CLI for `sessionId`. */
  register(sessionId: string, text: string, clientMessageId?: string): void {
    const list = this.pending.get(sessionId) ?? [];
    list.push({ text: normalize(text), clientMessageId });
    if (list.length > MAX_PENDING) list.splice(0, list.length - MAX_PENDING);
    this.pending.set(sessionId, list);
  }

  /**
   * The CLI submitted a prompt. Returns the `turn_started` to announce, or null when the prompt
   * is not one PPM pushed (or carries no usable id). The oldest matching push wins.
   */
  bind(sessionId: string, promptId: unknown, prompt: unknown): { turnId: string; clientMessageId?: string } | null {
    if (typeof promptId !== "string" || !TURN_ID_RE.test(promptId) || typeof prompt !== "string") return null;
    const list = this.pending.get(sessionId);
    if (!list?.length) return null;
    const text = normalize(prompt);
    let at = list.findIndex((p) => p.text === text);
    // The CLI may append pasted content to what was typed; the push is still where it starts.
    if (at === -1) at = list.findIndex((p) => p.text && text.startsWith(p.text));
    if (at === -1) return null;
    const match = list[at]!;
    // Re-sends of the same browser message became this one turn and go with it. Everything else
    // stays: a `now` message can be submitted ahead of older ones, and the same words sent twice
    // are two messages.
    const rest = list.filter((p, i) => i !== at && !(p.text === match.text && p.clientMessageId === match.clientMessageId));
    if (rest.length) this.pending.set(sessionId, rest);
    else this.pending.delete(sessionId);
    return { turnId: promptId, ...(match.clientMessageId ? { clientMessageId: match.clientMessageId } : {}) };
  }

  forget(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
