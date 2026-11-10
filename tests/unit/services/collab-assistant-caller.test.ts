/**
 * The PPM Assistant as a caller of the session tools: it reaches a chat of any registered project
 * but never an Assistant or design chat, every create and message is asked on a card (whatever the
 * settings say), the new chat starts at depth 0 in the provider's default mode and model as a chat
 * of the user's own, and the delivery carries the target's project, the approved mode and the
 * Assistant as the sender.
 */
import { describe, expect, it } from "bun:test";
import { resolveCaller, resolveTarget } from "../../../src/services/session-collab/collab-context.ts";
import { createSessionTool } from "../../../src/services/session-collab/collab-create.ts";
import { sendToSessionTool } from "../../../src/services/session-collab/collab-send.ts";
import { fakeEnv, OTHER_PATH, PROJECT_PATH, textOf, type FakeSession } from "./session-collab-fake-env.ts";

const ASSISTANT = "a0000000-0000-4000-8000-000000000001";
const TARGET = "b0000000-0000-4000-8000-000000000002";
const OTHER_ASSISTANT = "c0000000-0000-4000-8000-000000000003";
const DESIGN = "d0000000-0000-4000-8000-000000000004";
const signal = () => new AbortController().signal;

function world(opts: Parameters<typeof fakeEnv>[0] extends infer O ? Partial<O> : never = {}) {
  const sessions: Record<string, FakeSession> = {
    [ASSISTANT]: { providerId: "claude", projectPath: "/ppm/assistant", title: "Ops", live: { phase: "streaming" } },
    [TARGET]: { providerId: "claude", projectPath: OTHER_PATH, title: "Fix login", mode: "acceptEdits" },
    [OTHER_ASSISTANT]: { providerId: "claude", projectPath: "/ppm/assistant" },
    [DESIGN]: { providerId: "claude", projectPath: OTHER_PATH, design: true },
  };
  const fake = fakeEnv({ sessions, assistants: [ASSISTANT, OTHER_ASSISTANT], ...opts });
  const caller = resolveCaller(fake.env, ASSISTANT);
  if (!caller.ok) throw new Error(caller.message);
  return { ...fake, caller: caller.value };
}

describe("an Assistant caller", () => {
  it("is resolved as the Assistant, attended or not", () => {
    expect(world().caller).toMatchObject({ kind: "assistant", unattended: false, projectName: "__assistant__" });
    expect(world({ unattended: [ASSISTANT] }).caller.unattended).toBe(true);
  });

  it("reaches a chat of another registered project, with that project", () => {
    const w = world();
    const target = resolveTarget(w.env, w.caller, TARGET);
    expect(target).toMatchObject({ ok: true, value: { sessionId: TARGET, projectName: "other", projectPath: OTHER_PATH } });
  });

  it("never reaches an Assistant chat or a design chat", () => {
    const w = world();
    expect(resolveTarget(w.env, w.caller, OTHER_ASSISTANT)).toMatchObject({ ok: false, refusal: "assistant_session" });
    expect(resolveTarget(w.env, w.caller, DESIGN)).toMatchObject({ ok: false, refusal: "design_session" });
  });
});

describe("send_to_session from the Assistant", () => {
  it("asks with a message card naming the chat, its project and its mode, then delivers into that project", async () => {
    const w = world({ answers: ["allow_once"] });
    const result = await sendToSessionTool(w.env, w.caller, { session_id: TARGET, message: "run the tests" }, signal());
    expect(result.isError).toBeUndefined();
    expect(w.asked).toEqual([{
      kind: "message", targetSessionId: TARGET, targetTitle: "Fix login", projectName: "other", providerId: "claude",
      permissionMode: "acceptEdits", modeSource: "stored", message: "run the tests",
    }]);
    // Delivered into the target's project, held to the mode the user approved, the Assistant named as sender.
    expect(w.deliveries[0]).toMatchObject({
      targetSessionId: TARGET, projectName: "other", projectPath: OTHER_PATH, body: "run the tests", expectedMode: "acceptEdits",
    });
    expect(w.deliveries[0]!.fromSession).toMatchObject({ sessionId: ASSISTANT, projectName: "__assistant__", kind: "assistant" });
    // The tool card opens the chat in its own project; no pair or link ties the two chats.
    expect(JSON.parse(textOf(result)).project).toBe("other");
    expect(w.announced).toEqual([]);
  });

  it("sends nothing when the user declines", async () => {
    const w = world({ answers: ["deny"] });
    const result = await sendToSessionTool(w.env, w.caller, { session_id: TARGET, message: "deploy" }, signal());
    expect(result.isError).toBe(true);
    expect(w.deliveries).toHaveLength(0);
  });

  it("sends nothing when the chat would now run it in another mode than the card stated", async () => {
    const modes: Record<string, string> = { [TARGET]: "default" };
    const w = world({ answers: ["allow_once"], chatModes: modes, onApprove: () => { modes[TARGET] = "bypassPermissions"; } });
    const result = await sendToSessionTool(w.env, w.caller, { session_id: TARGET, message: "go" }, signal());
    expect(textOf(result)).toContain("Ask again");
    expect(w.deliveries).toHaveLength(0);
  });
});

describe("create_session from the Assistant", () => {
  it("always asks, even with asking switched off, and opens the chat in the named project at depth 0", async () => {
    const w = world({ answers: ["allow_once"], settings: { askBeforeCreate: false }, providerDefaultMode: "default" });
    const result = await createSessionTool(w.env, w.caller, { title: "Audit", task: "audit the API", project: "other" }, signal());
    expect(result.isError).toBeUndefined();
    expect(w.asked[0]).toMatchObject({
      kind: "create", askedBy: "assistant", projectName: "other", depth: 0, model: null,
      permissionMode: "default", modeSource: "provider-default", task: "audit the API",
    });
    const out = JSON.parse(textOf(result));
    // A chat the user let the Assistant open is theirs: not AI-created, not linked to the Assistant.
    expect(out).toMatchObject({ project: "other", model: null, status: { depth: 0, spawnedBy: null } });
    expect(w.createdEvents[0]).toMatchObject({ projectName: "other", spawnedBy: null, depth: 0 });
    expect(w.announced).toEqual([`created:${out.sessionId}`]);
    expect(w.deliveries[0]).toMatchObject({ projectName: "other", projectPath: OTHER_PATH, permissionMode: "default" });
    expect(w.deliveries[0]!.fromSession.kind).toBe("assistant");
  });

  it("takes the provider's most permissive default when none is configured, and says so on the card", async () => {
    const w = world({ answers: ["allow_once"] });
    await createSessionTool(w.env, w.caller, { title: "Audit", task: "x", project: "app" }, signal());
    expect(w.asked[0]).toMatchObject({ projectName: "app", permissionMode: "bypassPermissions" });
    expect(w.deliveries[0]!.projectPath).toBe(PROJECT_PATH);
  });

  it("requires a registered project other than the Assistant's own, before asking", async () => {
    const w = world({ answers: ["allow_once"] });
    for (const project of [undefined, "", "nope", "__assistant__"]) {
      const result = await createSessionTool(w.env, w.caller, { title: "T", task: "x", ...(project !== undefined ? { project } : {}) }, signal());
      expect(result.isError).toBe(true);
    }
    expect(w.asked).toHaveLength(0);
    expect(w.created).toHaveLength(0);
  });

  it("creates nothing when the user declines", async () => {
    const w = world({ answers: ["deny"] });
    expect((await createSessionTool(w.env, w.caller, { title: "T", task: "x", project: "other" }, signal())).isError).toBe(true);
    expect(w.created).toHaveLength(0);
  });
});
