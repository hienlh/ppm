/** Local dispatch evidence, deliberately independent of tour state and server turn IDs. */
export interface ChatAttemptEvent {
  type: "started" | "succeeded" | "failed" | "session";
  attemptId: string;
  sessionId: string;
  previousSessionId?: string;
  hasContent?: boolean;
}

export class ChatAttemptLifecycle {
  private attempt: { attemptId: string; sessionId: string } | null = null;
  constructor(private emit: (event: ChatAttemptEvent) => void) {}

  start(sessionId: string, idle: boolean, connected: boolean) {
    // A follow-up can overlap an earlier done frame: never attribute it as success.
    this.fail();
    if (!idle || !connected) return;
    this.attempt = { sessionId, attemptId: crypto.randomUUID() };
    this.emit({ type: "started", ...this.attempt });
  }

  migrate(sessionId: string) {
    if (!this.attempt || this.attempt.sessionId === sessionId) return;
    const previousSessionId = this.attempt.sessionId;
    this.attempt.sessionId = sessionId;
    this.emit({ type: "session", ...this.attempt, previousSessionId });
  }

  select(sessionId: string | null) {
    if (this.attempt && this.attempt.sessionId !== sessionId) this.fail();
  }

  fail() {
    if (!this.attempt) return;
    const attempt = this.attempt;
    this.attempt = null;
    this.emit({ type: "failed", ...attempt });
  }

  finish(hasContent: boolean) {
    if (!this.attempt) return;
    const attempt = this.attempt;
    this.attempt = null;
    this.emit({ type: hasContent ? "succeeded" : "failed", ...attempt, hasContent });
  }
}
