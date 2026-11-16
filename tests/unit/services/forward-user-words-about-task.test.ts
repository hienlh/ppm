import { describe, expect, it } from "bun:test";
import { forwardUserWordsAboutTask, type ForwardEnv } from "../../../src/services/assistant-cards/forward-verbatim.ts";
import type { DeliverUserWordsInput } from "../../../src/server/ws/chat-user-words.ts";
import type { TaskReference } from "../../../src/shared/chat-task-ref.ts";

const taskRef: TaskReference = {
  version: 1, taskId: "0f1e2d3c-4b5a-4968-8776-655443322110", ref: "alpha/12", number: 12, projectName: "alpha",
  title: "Fix the login timeout", status: "In progress", urgency: "today", due: null, link: "http://localhost:8080/project/alpha/task/x",
};
const target = { sessionId: "mgr-alpha", providerId: "claude", projectName: "alpha", projectPath: "/p/alpha" };

function envWith(result: { ok: true } | { ok: false; error: string }) {
  const sent: DeliverUserWordsInput[] = [];
  const notes: string[] = [];
  const traced: Array<Record<string, unknown>> = [];
  const wrote: string[] = [];
  const env: ForwardEnv = {
    now: () => Date.UTC(2026, 10, 16, 8, 0, 0),
    managerTarget: () => null,
    deliverUserWords: async (input) => {
      sent.push(input);
      return result.ok ? { ok: true, content: input.text, sessionId: input.targetSessionId, delivered: "started", clientMessageId: input.clientMessageId! } : result;
    },
    sendToAssistant: async () => ({ ok: true }),
    userWrote: (id) => { wrote.push(id); },
    mainSession: () => "assistant-main",
    note: (_id, line) => { notes.push(line); },
    trace: (_s, _p, payload) => { traced.push(payload); },
  };
  return { env, sent, notes, traced, wrote };
}

describe("the user's words about a task", () => {
  it("go to the task's chat word for word, with a user-words block naming no card and the task's block", async () => {
    const { env, sent, notes, traced, wrote } = envWith({ ok: true });
    const r = await forwardUserWordsAboutTask({
      text: "fix it now", target, taskRef, actor: { channel: "telegram", telegramChatId: "42", telegramMessageId: 7 },
    }, env);
    expect(r).toEqual({ ok: true, sessionId: "mgr-alpha", delivered: "started" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      targetSessionId: "mgr-alpha", text: "fix it now", taskRefs: [taskRef], supersede: false,
      userWords: { channel: "telegram", at: "2026-11-16T08:00:00.000Z" },
    });
    expect(sent[0]!.userWords.cardId).toBeUndefined();
    expect(sent[0]!.clientMessageId).toMatch(/^card-[0-9a-f-]{36}$/);
    expect(wrote).toEqual(["mgr-alpha"]);
    expect(traced).toEqual([{ taskId: taskRef.taskId, channel: "telegram", telegramChatId: "42" }]);
    expect(notes[0]).toContain("task alpha/12");
    expect(notes[0]).not.toContain("fix it now");
  });

  it("a refused delivery says why and tells nobody", async () => {
    const { env, notes, wrote } = envWith({ ok: false, error: "A design chat does not take forwarded words" });
    const r = await forwardUserWordsAboutTask({ text: "x", target, taskRef, actor: { channel: "telegram" } }, env);
    expect(r).toEqual({ ok: false, error: "A design chat does not take forwarded words" });
    expect(notes).toEqual([]);
    expect(wrote).toEqual([]);
  });
});
