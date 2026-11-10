import { NO_REPLY_TEXT } from "../../shared/assistant-cards.ts";

/**
 * Holds back the Telegram mirror of a turn PPM started on its own until it is clear the Assistant
 * has something to say. A wake turn whose whole answer is `[no reply]` (the cards were already in
 * front of the user) never reaches the phone: not the news line, not its tool calls, not the text.
 * Anything else is released as it would have been, in order, the moment the text stops looking
 * like the start of `[no reply]`.
 */

interface Held {
  text: string;
  tools: string[];
  /** The line that announces the turn on Telegram once it is released. */
  line?: string;
}

export class WakeTurnGate {
  private readonly held = new Map<string, Held>();

  /** A wake turn began in this session: hold it, and the line that will announce it. */
  hold(sessionId: string, line?: string): void {
    this.held.set(sessionId, { text: "", tools: [], ...(line ? { line } : {}) });
  }

  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** A tool call of a held turn, kept for the release. */
  tool(sessionId: string, name: string): void {
    this.held.get(sessionId)?.tools.push(name);
  }

  /**
   * Text of a held turn. Returns what to release (the held tools and all the text so far) once the
   * text can no longer be `[no reply]`; null while it still could be.
   */
  text(sessionId: string, chunk: string): Held | null {
    const h = this.held.get(sessionId);
    if (!h) return null;
    h.text += chunk;
    const sofar = h.text.trimStart().toLowerCase();
    if (sofar.length <= NO_REPLY_TEXT.length + 2 && NO_REPLY_TEXT.startsWith(sofar.trimEnd())) return null;
    this.held.delete(sessionId);
    return h;
  }

  /** The held turn ended: what to release, or null when it said nothing worth sending. */
  end(sessionId: string, outcome: "done" | "stopped" | "failed"): Held | null {
    const h = this.held.get(sessionId);
    if (!h) return null;
    this.held.delete(sessionId);
    const said = h.text.trim().toLowerCase();
    if (outcome === "done" && (said === NO_REPLY_TEXT || (said === "" && h.tools.length === 0))) return null;
    return h;
  }

  rename(oldId: string, newId: string): void {
    const h = this.held.get(oldId);
    if (!h) return;
    this.held.delete(oldId);
    this.held.set(newId, h);
  }
}
