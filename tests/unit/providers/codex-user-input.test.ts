import { describe, expect, it } from "bun:test";
import { mapCodexEvent } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";
import { mapRolloutItem } from "../../../src/providers/codex-app-server/codex-rollout-items.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";

const questions = [{ title: "Which database?", options: ["SQLite", "Postgres"] }];

describe("Codex user questions", () => {
  it("preserves completed async questions as interactive events", () => {
    const events = mapCodexEvent({ method: "item/completed", params: { item: {
      type: "agentMessage", id: "ask-1", delivery: "async", questions,
    } } }, "thread-1");
    expect(events).toEqual([{
      type: "tool_use", tool: "RequestUserInput", toolUseId: "ask-1",
      input: { questions: [{ id: "0", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] }] },
    }]);
  });

  it("restores the same question from history instead of flattening it to text", () => {
    const live = mapCodexEvent({ method: "item/completed", params: { item: {
      type: "agentMessage", id: "ask-1", delivery: "async", questions,
    } } }, "thread-1");
    expect(mapRolloutItem({ type: "AgentMessage", id: "ask-1", delivery: "async", questions,
      content: [{ type: "Text", text: "Which database?" }],
    })).toEqual({ kind: "events", events: live });
  });

  it("leaves ordinary agent messages alone", () => {
    expect(mapCodexEvent({ method: "item/completed", params: { item: {
      type: "agentMessage", id: "text-1", text: "Hello", questions: null,
    } } }, "thread-1")).toEqual([]);
  });

  it("passes structured synchronous questions and responds using Codex question IDs", () => {
    const provider: any = new CodexAppServerProvider();
    const events: any[] = [];
    const replies: any[] = [];
    const live: any = { pendingApprovals: new Map(), answeredCodexIds: new Set(),
      channel: { push: (event: unknown) => events.push(event) },
      client: { respond: (id: unknown, result: unknown) => replies.push({ id, result }) },
    };
    provider.live.set("thread-1", live);
    provider.handleServerRequest(live, { id: 42, method: "item/tool/requestUserInput", params: {
      questions: [{ id: "database", question: "Which database?", header: "DB", options: null }],
    } });
    expect(events[0].input).toEqual({ questions: [{ id: "database", question: "Which database?", header: "DB", options: [] }] });
    provider.resolveApproval(events[0].requestId, true, { database: "SQLite" });
    expect(replies).toEqual([{ id: 42, result: { answers: { database: { answers: ["SQLite"] } } } }]);
  });

  it("translates legacy question-text keys and returns no answers when skipped", () => {
    const provider: any = new CodexAppServerProvider();
    const events: any[] = [];
    const replies: any[] = [];
    const live: any = { pendingApprovals: new Map(), answeredCodexIds: new Set(),
      channel: { push: (event: unknown) => events.push(event) },
      client: { respond: (id: unknown, result: unknown) => replies.push({ id, result }) },
    };
    provider.live.set("thread-1", live);
    for (const id of [1, 2]) provider.handleServerRequest(live, { id, method: "item/tool/requestUserInput", params: {
      questions: [{ id: "database", question: "Which database?", options: [] }],
    } });
    provider.resolveApproval(events[0].requestId, true, { "Which database?": "SQLite" });
    provider.resolveApproval(events[1].requestId, false, { database: "Postgres" });
    expect(replies).toEqual([
      { id: 1, result: { answers: { database: { answers: ["SQLite"] } } } },
      { id: 2, result: { answers: {} } },
    ]);
  });
});
