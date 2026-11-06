import { describe, expect, it } from "bun:test";
import { sessionStatusTool, statusOf } from "../../../src/services/session-collab/collab-status.ts";
import { resolveCaller } from "../../../src/services/session-collab/collab-context.ts";
import { fakeEnv, OTHER_PATH, PROJECT_PATH, textOf } from "./session-collab-fake-env.ts";

const A = "session-aaaa";
const CHILD = "session-child";

function world() {
  const fake = fakeEnv({
    sessions: {
      [A]: { providerId: "claude", projectPath: PROJECT_PATH, title: "Parent", mode: "default" },
      [CHILD]: {
        providerId: "codex", projectPath: PROJECT_PATH, title: "Child", parent: A, depth: 1, model: "gpt-5",
        live: { phase: "streaming", waitingFor: "approval", lastAnswer: "Here:\n```ts\nconst x = 1\n```", updatedAt: 0 },
      },
      "session-far": { providerId: "claude", projectPath: OTHER_PATH, title: "Elsewhere" },
    },
  });
  const caller = resolveCaller(fake.env, A);
  if (!caller.ok) throw new Error(caller.message);
  return { ...fake, caller: caller.value };
}

describe("session_status", () => {
  it("reports the linked sessions by default, from the registry, with the last answer's fences broken", () => {
    const w = world();
    const body = JSON.parse(textOf(sessionStatusTool(w.env, w.caller, {})));
    expect(body.sessions).toHaveLength(1);
    const s = body.sessions[0];
    expect(s).toMatchObject({ sessionId: CHILD, title: "Child", providerId: "codex", model: "gpt-5", phase: "streaming", waitingFor: "approval", spawnedBy: A, depth: 1 });
    expect(s.lastAssistantText).not.toContain("```");
  });

  it("counts messages that reached the caller outside a wait until the caller asks", () => {
    const w = world();
    w.env.unread.add(CHILD, A);
    w.env.unread.add(CHILD, A);
    expect(statusOf(w.env, CHILD, "codex", A).unreadReplies).toBe(2);
    const body = JSON.parse(textOf(sessionStatusTool(w.env, w.caller, { session_ids: [CHILD] })));
    expect(body.sessions[0].unreadReplies).toBe(2);
    expect(statusOf(w.env, CHILD, "codex", A).unreadReplies).toBe(0);
  });

  it("refuses another project's session by name and keeps the rest", () => {
    const w = world();
    const result = sessionStatusTool(w.env, w.caller, { session_ids: [CHILD, "session-far"] });
    const body = JSON.parse(textOf(result));
    expect(body.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([CHILD]);
    expect(body.errors[0]).toContain("another project");
    expect(result.isError).toBeUndefined();
    expect(sessionStatusTool(w.env, w.caller, { session_ids: "x" }).isError).toBe(true);
  });

  it("answers an empty list when nothing is linked yet", () => {
    const w = fakeEnv({ sessions: { [A]: { providerId: "claude", projectPath: PROJECT_PATH } } });
    const caller = resolveCaller(w.env, A);
    if (!caller.ok) throw new Error(caller.message);
    expect(JSON.parse(textOf(sessionStatusTool(w.env, caller.value, {})))).toEqual({ sessions: [] });
  });
});
