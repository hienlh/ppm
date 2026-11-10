/**
 * A stand-in for Claude with the CLI's input queue: one stream per session, input taken in order.
 * A message pushed with priority `later` waits for the running turn to end; any other push while a
 * turn runs is logged as `mid:<session>` (the CLI would read it at the turn's next step). A message
 * containing `HOLD` keeps its turn open until `release`; `kill` is the CLI dying, taking whatever
 * waited in its queue with it.
 *
 * `log` records `start:<session>:<tag>` and `done:<session>:<tag>` per turn, where the tag is `ask`
 * for the morning digest's ask, `hold` for a held turn, `other` for anything else.
 */
import type { ChatEvent, Session } from "../../../src/types/chat.ts";

interface Item { content: string; clientMessageId?: string }
interface Stream { queue: Item[]; wake?: () => void; gate?: () => void; closed: boolean; running: boolean }

const ASK_MARK = "Morning digest. When you are free";
const tagOf = (content: string) => (content.includes(ASK_MARK) ? "ask" : content.includes("HOLD") ? "hold" : "other");

export class ScriptedCli {
  id = "claude";
  name = "Scripted Claude";
  supportsAssistantSessions = true;
  supportsSharedContext = true;
  sessions = new Map<string, Session>();
  received: Array<{ sessionId: string; message: string; priority?: string; opts?: { sharedContext?: string } }> = [];
  log: string[] = [];
  private streams = new Map<string, Stream>();

  async createSession(): Promise<Session> {
    const session: Session = { id: crypto.randomUUID(), providerId: this.id, title: "Scripted", createdAt: new Date().toISOString() };
    this.sessions.set(session.id, session);
    return session;
  }
  async resumeSession(sessionId: string): Promise<Session> {
    const s = this.sessions.get(sessionId) ?? { id: sessionId, providerId: this.id, title: "Resumed", createdAt: new Date().toISOString() };
    this.sessions.set(sessionId, s);
    return s;
  }
  ensureProjectPath(): void {}
  async listSessions() { return []; }
  async deleteSession(sessionId: string) { this.sessions.delete(sessionId); }
  hasStreamingSession(sessionId: string): boolean { return this.streams.has(sessionId); }
  resolveApproval(): void {}
  running(sessionId: string): boolean { return this.streams.get(sessionId)?.running ?? false; }
  release(sessionId: string): void { this.streams.get(sessionId)?.gate?.(); }
  releaseAll(): void { for (const id of [...this.streams.keys()]) this.kill(id); }
  abortQuery(sessionId: string): void { this.kill(sessionId); }

  /** The CLI dies: its queue is gone, the running turn ends. */
  kill(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    s.queue.length = 0;
    s.closed = true;
    s.gate?.();
    s.wake?.();
  }

  pushMessage(sessionId: string, content: string, opts?: { clientMessageId?: string; priority?: string; sharedContext?: string }): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    this.received.push({ sessionId, message: content, priority: opts?.priority, opts });
    if (s.running && opts?.priority !== "later") this.log.push(`mid:${sessionId}`);
    s.queue.push({ content, clientMessageId: opts?.clientMessageId });
    s.wake?.();
  }

  async *sendMessage(sessionId: string, message: string, opts?: { clientMessageId?: string; priority?: string; sharedContext?: string }): AsyncGenerator<ChatEvent> {
    this.received.push({ sessionId, message, priority: opts?.priority, opts });
    const stream: Stream = { queue: [{ content: message, clientMessageId: opts?.clientMessageId }], closed: false, running: false };
    this.streams.set(sessionId, stream);
    try {
      for (;;) {
        while (!stream.queue.length && !stream.closed) await new Promise<void>((r) => { stream.wake = r; });
        if (stream.closed) return;
        const item = stream.queue.shift()!;
        const tag = tagOf(item.content);
        stream.running = true;
        this.log.push(`start:${sessionId}:${tag}`);
        yield { type: "turn_started", turnId: `turn-${crypto.randomUUID()}`, ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}) } as ChatEvent;
        yield { type: "text", content: "Working on it." } as ChatEvent;
        if (tag === "hold") await new Promise<void>((r) => { stream.gate = r; });
        stream.running = false;
        this.log.push(`done:${sessionId}:${tag}`);
        yield { type: "done", sessionId } as ChatEvent;
        if (stream.closed) return;
      }
    } finally {
      if (this.streams.get(sessionId) === stream) this.streams.delete(sessionId);
    }
  }
}
