import { describe, expect, it } from "bun:test";
import { createTaskWordsFollowups, type TaskFollowupContext, type TaskFollowupDelivery } from "../../../src/services/assistant-cards/task-words-followup.ts";
import { formatTaskFollowup } from "../../../src/services/assistant-telegram/assistant-telegram-task-followups.ts";

const context = (detail: "full" | "title" = "full", messageId = 41): TaskFollowupContext => ({
  origin: { channel: "telegram", chatId: "500", messageId },
  taskRef: { taskId: "0f1e2d3c-4b5a-4968-8776-655443322110", ref: "alpha/12", title: "Fix the login timeout" },
  chat: { kind: "manager", chatTitle: null, detail, projectKey: "k-alpha", projectName: "alpha", providerId: "claude" },
});

function harness(opts: { cardShowing?: "approval" | "question" | null } = {}) {
  const sent: TaskFollowupDelivery[] = [];
  let now = 1_000;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  let running = false;
  let turn = "t0";
  const f = createTaskWordsFollowups({
    canonical: (id) => id,
    isIdle: () => !running,
    turnId: () => turn,
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return () => { t.live = false; }; },
    sink: () => ({ send: (d) => { sent.push(d); } }),
    cardShowing: () => opts.cardShowing ?? null,
    scrub: (t) => t.replace("VAULT-SECRET", "[vault]"),
  });
  const advance = (ms: number) => { now += ms; for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); } };
  /** The words open their own turn: it is named by their client id, as providers do. */
  const openTurn = (session: string, clientMessageId: string, id: string) => {
    running = true;
    turn = id;
    f.onStream(session, { type: "turn_started", clientMessageId });
  };
  const say = (session: string, text: string) => f.onStream(session, { type: "text", content: text });
  const end = (session: string, outcome: "done" | "stopped" | "failed" = "done", error?: string) => {
    running = false;
    f.onTurnEnded(session, { outcome, ...(error ? { error } : {}) });
  };
  return { f, sent, advance, openTurn, say, end };
}

describe("the answer to words about a task", () => {
  it("is the final text of the turn those words opened, once, and never a later turn's", () => {
    const h = harness();
    const handle = h.f.expect({ clientMessageId: "card-a", sessionId: "mgr", context: context() });
    handle.attach("started");
    h.openTurn("mgr", "card-a", "t1");
    h.say("mgr", "Checking the logs.");
    h.f.onStream("mgr", { type: "tool_use" });
    h.say("mgr", "It is blocked on QA; Mai reviews it today.");
    h.end("mgr");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ kind: "answer", sessionId: "mgr", repliedAt: 1_000 });
    expect((h.sent[0] as { text: string }).text).toContain("blocked on QA");
    // A later turn of the same chat (a schedule, another message) is not forwarded.
    h.openTurn("mgr", "other", "t2");
    h.say("mgr", "Unrelated work.");
    h.end("mgr");
    expect(h.sent).toHaveLength(1);
    expect(h.f.size()).toBe(0);
  });

  it("says once that the turn waits on a card, then still sends the answer", () => {
    const h = harness();
    h.f.expect({ clientMessageId: "card-b", sessionId: "mgr", context: context() }).attach("started");
    h.openTurn("mgr", "card-b", "t1");
    h.f.onCardShown("mgr", "approval");
    h.f.onCardShown("mgr", "question");
    expect(h.sent.map((d) => d.kind)).toEqual(["waiting"]);
    expect(h.sent[0]).toMatchObject({ waitingFor: "approval" });
    h.say("mgr", "Done, merged.");
    h.end("mgr");
    expect(h.sent.map((d) => d.kind)).toEqual(["waiting", "answer"]);
  });

  it("words queued behind a card already showing are told at once that the chat waits", () => {
    const h = harness({ cardShowing: "question" });
    h.f.expect({ clientMessageId: "card-q", sessionId: "mgr", context: context() }).attach("queued");
    expect(h.sent).toMatchObject([{ kind: "waiting", waitingFor: "question" }]);
    // Shown again once the card is answered and another follows: still once.
    h.f.onCardShown("mgr", "approval");
    expect(h.sent).toHaveLength(1);
  });

  it("a turn that wrote nothing still says it ended", () => {
    const h = harness();
    h.f.expect({ clientMessageId: "card-n", sessionId: "mgr", context: context() }).attach("started");
    h.openTurn("mgr", "card-n", "t1");
    h.f.onStream("mgr", { type: "tool_use" });
    h.end("mgr");
    expect(h.sent).toMatchObject([{ kind: "answer", text: "" }]);
  });

  it("words no turn named, when another turn ran first, point at the chat instead of going quiet", () => {
    const h = harness();
    // Pushed into a running turn that never names them (Claude does that).
    h.f.expect({ clientMessageId: "card-u", sessionId: "mgr", context: context() }).attach("inserted");
    h.say("mgr", "an answer, maybe");
    h.end("mgr");
    // Another turn opens before the grace runs out: the answer cannot be told apart.
    h.openTurn("mgr", "someone-else", "t9");
    h.advance(4_000);
    expect(h.sent).toMatchObject([{ kind: "unclear" }]);
    expect(h.f.size()).toBe(0);
  });

  it("a card shown in another chat, or in a turn that is not theirs, says nothing", () => {
    const h = harness();
    h.f.expect({ clientMessageId: "card-c", sessionId: "mgr", context: context() }).attach("queued");
    h.f.onCardShown("mgr", "approval");
    h.f.onCardShown("child", "approval");
    expect(h.sent).toEqual([]);
  });

  it("reports an error with its message, and a stop without one", () => {
    const h = harness();
    h.f.expect({ clientMessageId: "card-d", sessionId: "mgr", context: context() }).attach("started");
    h.openTurn("mgr", "card-d", "t1");
    h.say("mgr", "half an answer");
    h.end("mgr", "failed", "API Error: 529 overloaded VAULT-SECRET\nstack…");
    expect(h.sent[0]).toMatchObject({ kind: "failed", error: "API Error: 529 overloaded [vault]\nstack…" });

    h.f.expect({ clientMessageId: "card-e", sessionId: "mgr", context: context() }).attach("started");
    h.openTurn("mgr", "card-e", "t2");
    h.end("mgr", "stopped");
    expect(h.sent[1]).toMatchObject({ kind: "stopped" });
  });

  it("a turn that answered only with a card names the card", () => {
    const h = harness();
    h.f.expect({ clientMessageId: "card-f", sessionId: "mgr", context: context() }).attach("started");
    h.openTurn("mgr", "card-f", "t1");
    h.f.onCardCreated({ id: "c1", title: "Needs your decision", sessionId: "mgr", kind: "needs_decision" });
    h.f.onStream("mgr", { type: "tool_use" });
    h.say("mgr", "Card sent.");
    h.end("mgr");
    expect(h.sent[0]).toMatchObject({ kind: "cards", cards: [{ id: "c1", title: "Needs your decision" }] });
  });

  it("words that were never delivered are forgotten", () => {
    const h = harness();
    h.f.expect({ clientMessageId: "card-g", sessionId: "mgr", context: context() }).abandon();
    expect(h.f.size()).toBe(0);
  });
});

describe("what Telegram is told", () => {
  const url = "https://ppm.example.com/project/alpha?openChat=claude/mgr";
  const base = { sessionId: "mgr", repliedAt: 0 };

  it("names the chat and the task, escapes before formatting, and links the chat", () => {
    const out = formatTaskFollowup({ ...base, kind: "answer", context: context(), text: "Use <b>retry</b> & **backoff**", overflow: false }, url);
    expect(out.html).toStartWith("💬 <b>The alpha manager chat</b> answered, about <code>alpha/12</code> · <b>Fix the login timeout</b>:");
    expect(out.html).toContain("&lt;b&gt;retry&lt;/b&gt; &amp;");
    expect(out.html).toContain("<b>backoff</b>");
    expect(JSON.stringify(out)).toContain(url);
  });

  it("cuts a long answer to one message and redacts secrets", () => {
    const key = `AKIA${"Q".repeat(16)}`;
    const out = formatTaskFollowup({ ...base, kind: "answer", context: context(), text: `${key} ${"word ".repeat(2000)}`, overflow: false }, url);
    expect(out.html).not.toContain("AKIA");
    expect(out.html).toContain("see the chat for the rest");
    expect(out.html.length).toBeLessThan(4096);
  });

  it("keeps a title-only project's answer, error and chat title in PPM", () => {
    const titleOnly: TaskFollowupContext = { ...context("title"), chat: { ...context("title").chat, kind: "child", chatTitle: "Secret client fix" } };
    const answer = formatTaskFollowup({ ...base, kind: "answer", context: titleOnly, text: "ACME salaries are wrong", overflow: false }, url);
    expect(answer.html).not.toContain("ACME");
    expect(answer.html).not.toContain("Secret client fix");
    expect(answer.html).toContain("details stay in PPM");
    const failed = formatTaskFollowup({ ...base, kind: "failed", context: titleOnly, error: "ACME payroll crashed" }, url);
    expect(failed.html).not.toContain("ACME");
  });

  it("says when there is no written answer, or the answer could not be told apart", () => {
    expect(formatTaskFollowup({ ...base, kind: "answer", context: context(), text: "", overflow: false }, url).html)
      .toContain("finished its turn about <code>alpha/12</code> · <b>Fix the login timeout</b> without a written answer");
    expect(formatTaskFollowup({ ...base, kind: "unclear", context: context() }, url).html).toContain("its answer is in the chat");
  });

  it("says the chat waits on a card, was stopped, or failed", () => {
    expect(formatTaskFollowup({ ...base, kind: "waiting", waitingFor: "approval", context: context() }, url).html)
      .toStartWith("⏳ The <b>alpha</b> manager chat is waiting for your approval before it can answer about <code>alpha/12</code> · <b>Fix the login timeout</b>.");
    expect(formatTaskFollowup({ ...base, kind: "waiting", waitingFor: "question", context: context() }, url).html).toContain("your answer to a question");
    expect(formatTaskFollowup({ ...base, kind: "stopped", context: context() }, url).html).toContain("was stopped before it answered");
    const failed = formatTaskFollowup({ ...base, kind: "failed", context: context(), error: "API Error: <529> overloaded\nat line 2" }, url).html;
    expect(failed).toContain("stopped on an error before it answered about");
    expect(failed).toContain("API Error: &lt;529&gt; overloaded");
    // Hidden characters are shown, not passed on.
    expect(formatTaskFollowup({ ...base, kind: "failed", context: context(), error: `bad${String.fromCharCode(0x202e)}gnirts` }, url).html)
      .not.toContain(String.fromCharCode(0x202e));
    expect(failed).not.toContain("at line 2");
  });
});
