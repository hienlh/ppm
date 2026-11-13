import { setSessionMetadata } from "../../src/services/db.service.ts";
import type { AIProvider, Session, SessionConfig, ChatEvent, SendMessageOpts } from "../../src/providers/provider.interface.ts";

/**
 * A provider whose generator, like the SDK's, stays open after `done` and takes the next
 * message off `pushMessage` as a turn of its own — what a message pushed behind a running
 * turn becomes. Each message is a script read from its text: `ask:` raises an approval and
 * waits for the answer, `err:` reports an error, `hold:` then waits for `release()`, `slow:`
 * waits before the first event; everything else answers at once.
 */
export class QueuedTurnsProvider implements AIProvider {
  name = "Queued Turns Provider";
  sessions = new Map<string, Session>();
  private aborts = new Map<string, AbortController>();
  private nextMessage = new Map<string, (content: string | undefined) => void>();
  /** Messages pushed while a turn ran, taken in order once it ends — the SDK's own queue. */
  private queued = new Map<string, string[]>();
  private holds = new Map<string, () => void>();
  private approvals = new Map<string, (approved: boolean) => void>();
  /** `resumeSession` waits on this when set — a slow resume for the race tests. */
  resumeHold?: Promise<void>;
  queries: Array<{ sessionId: string; message: string; opts?: SendMessageOpts }> = [];
  pushes: Array<{ sessionId: string; content: string }> = [];
  abortReasons: Array<{ sessionId: string; reason?: string }> = [];
  approvalAnswers: Array<{ requestId: string; approved: boolean }> = [];
  private requestSeq = 0;

  constructor(readonly id: string) {}

  async createSession(config: SessionConfig): Promise<Session> {
    const id = crypto.randomUUID();
    const session: Session = { id, providerId: this.id, title: config.title ?? "Test", projectName: config.projectName, projectPath: config.projectPath, createdAt: new Date().toISOString() };
    this.sessions.set(id, session);
    if (config.projectPath) setSessionMetadata(id, config.projectName, config.projectPath);
    return session;
  }
  async resumeSession(sessionId: string): Promise<Session> {
    if (this.resumeHold) await this.resumeHold;
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    return s;
  }
  async listSessions() { return []; }
  async deleteSession(sessionId: string) { this.sessions.delete(sessionId); }

  async *sendMessage(sessionId: string, message: string, opts?: SendMessageOpts): AsyncIterable<ChatEvent> {
    this.queries.push({ sessionId, message, opts });
    const controller = new AbortController();
    this.aborts.set(sessionId, controller);
    const aborted = () => new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    let current: string | undefined = message;
    while (current !== undefined && !controller.signal.aborted) {
      if (current.includes("slow:")) await Promise.race([Bun.sleep(80), aborted()]);
      yield { type: "text", content: `echo: ${current}` };
      if (current.includes("ask:")) {
        const requestId = `req-${++this.requestSeq}`;
        const answer = new Promise<boolean>((resolve) => {
          this.approvals.set(requestId, resolve);
          controller.signal.addEventListener("abort", () => resolve(false), { once: true });
        });
        yield { type: "approval_request", requestId, tool: "Bash", input: { command: "rm -rf build" } };
        yield { type: "text", content: (await answer) ? "approved" : "skipped" };
      }
      if (current.includes("err:")) yield { type: "error", message: "the turn hit an error" };
      if (current.includes("hold:")) {
        await Promise.race([new Promise<void>((resolve) => this.holds.set(sessionId, resolve)), aborted()]);
      }
      if (controller.signal.aborted) break;
      yield { type: "done", sessionId };
      const waiting = this.queued.get(sessionId)?.shift();
      current = waiting ?? await new Promise<string | undefined>((resolve) => {
        this.nextMessage.set(sessionId, resolve);
        controller.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    }
    this.aborts.delete(sessionId);
    this.queued.delete(sessionId);
  }
  pushMessage(sessionId: string, content: string): void {
    this.pushes.push({ sessionId, content });
    const resolve = this.nextMessage.get(sessionId);
    if (resolve) { this.nextMessage.delete(sessionId); resolve(content); return; }
    (this.queued.get(sessionId) ?? this.queued.set(sessionId, []).get(sessionId)!).push(content);
  }
  resolveApproval(requestId: string, approved: boolean): void {
    this.approvalAnswers.push({ requestId, approved });
    this.approvals.get(requestId)?.(approved);
    this.approvals.delete(requestId);
  }
  abortQuery(sessionId: string, reason?: string): void {
    this.abortReasons.push({ sessionId, reason });
    this.aborts.get(sessionId)?.abort();
  }
  release(sessionId: string): void { this.holds.get(sessionId)?.(); }
  hasStreamingSession(sessionId: string): boolean { return this.aborts.has(sessionId); }
}

export async function until(check: () => boolean, what: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
