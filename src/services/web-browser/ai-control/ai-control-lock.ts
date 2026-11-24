/**
 * Who drives the browser: the person, or an AI chat they allowed. The person always wins — a
 * click, a key, or "Take back" in the window stops every AI call until they hand it back — and
 * the window shows which chat is acting while one is.
 *
 * Which chats may act is remembered here per session for the life of the server: the first call
 * of a chat asks the user on a card (`browser-tools.ts`), and "Allow for this chat" lands here.
 */
import { EventEmitter } from "node:events";

/** An AI call more than this long ago no longer counts as "AI is using the browser". */
export const AI_ACTIVE_WINDOW_MS = 30_000;

export interface AiControlState {
  active: boolean;
  sessionId: string | null;
  sessionTitle: string | null;
  heldByUser: boolean;
}

/** Events: "change" (AiControlState). */
export class AiControlLock extends EventEmitter {
  private sessionId: string | null = null;
  private sessionTitle: string | null = null;
  private lastAt = 0;
  private held = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly granted = new Set<string>();

  state(now = Date.now()): AiControlState {
    const active = !!this.sessionId && now - this.lastAt < AI_ACTIVE_WINDOW_MS;
    return { active: active && !this.held, sessionId: active ? this.sessionId : null, sessionTitle: active ? this.sessionTitle : null, heldByUser: this.held };
  }

  isGranted(sessionId: string): boolean {
    return this.granted.has(sessionId);
  }

  grant(sessionId: string): void {
    this.granted.add(sessionId);
  }

  revokeAll(): void {
    this.granted.clear();
  }

  /** An AI call is about to act; false when the person holds the browser. */
  begin(sessionId: string, sessionTitle: string | null): boolean {
    if (this.held) return false;
    const changed = this.sessionId !== sessionId || !this.state().active;
    this.sessionId = sessionId;
    this.sessionTitle = sessionTitle;
    this.lastAt = Date.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emit("change", this.state()), AI_ACTIVE_WINDOW_MS + 50);
    if (changed) this.emit("change", this.state());
    return true;
  }

  /** The person takes the browser back (button, or their own input while an AI acts). */
  takeBack(): void {
    if (this.held) return;
    this.held = true;
    this.emit("change", this.state());
  }

  /** The person lets the AI carry on. */
  giveBack(): void {
    if (!this.held) return;
    this.held = false;
    this.emit("change", this.state());
  }
}

export const aiControlLock = new AiControlLock();
