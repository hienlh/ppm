import { describe, expect, it } from "bun:test";
import { createSessionTool } from "../../../src/services/session-collab/collab-create.ts";
import { resolveCaller } from "../../../src/services/session-collab/collab-context.ts";
import { fakeEnv, PROJECT_PATH, textOf, type FakeSession } from "./session-collab-fake-env.ts";

const PARENT = "parent-session";
const signal = () => new AbortController().signal;

function world(parent: Partial<FakeSession> = {}, opts: Omit<Parameters<typeof fakeEnv>[0], "sessions"> = {}) {
  const fake = fakeEnv({
    sessions: { [PARENT]: { providerId: "claude", projectPath: PROJECT_PATH, title: "Parent", mode: "acceptEdits", model: "opus", ...parent } },
    ...opts,
  });
  const caller = resolveCaller(fake.env, PARENT);
  if (!caller.ok) throw new Error(caller.message);
  return { ...fake, caller: caller.value };
}

describe("create_session", () => {
  it("asks first, then creates a titled child under the parent's mode and model, links it and hands it the task", async () => {
    const w = world({}, { answers: ["allow_once"] });
    const result = await createSessionTool(w.env, w.caller, { title: "  Write\nthe docs  ", task: "Document the API" }, signal());
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result));
    expect(body).toMatchObject({ sessionId: "child-session-1", title: "Write the docs", providerId: "claude", model: "opus" });
    expect(body.status).toMatchObject({ sessionId: "child-session-1", spawnedBy: PARENT, depth: 1 });
    expect(w.asked).toEqual([{ kind: "create", title: "Write the docs", providerId: "claude", model: "opus", taskPreview: "Document the API", depth: 1 }]);
    expect(w.deliveries).toHaveLength(1);
    expect(w.deliveries[0]).toMatchObject({ targetSessionId: "child-session-1", providerId: "claude", body: "Document the API", permissionMode: "acceptEdits", projectName: "app" });
    expect(w.deliveries[0]!.fromSession).toMatchObject({ sessionId: PARENT, title: "Parent", projectName: "app" });
    expect(w.starting.has("child-session-1")).toBe(true);
    expect(w.announced).toContain("created:child-session-1");
  });

  it("does not ask again after Allow for this session, nor when the user switched asking off", async () => {
    const w = world({}, { answers: ["allow_session"] });
    await createSessionTool(w.env, w.caller, { title: "One", task: "a" }, signal());
    await createSessionTool(w.env, w.caller, { title: "Two", task: "b" }, signal());
    expect(w.asked).toHaveLength(1);
    expect(w.created).toHaveLength(2);

    const off = world({}, { settings: { askBeforeCreate: false } });
    await createSessionTool(off.env, off.caller, { title: "One", task: "a" }, signal());
    expect(off.asked).toHaveLength(0);
    expect(off.created).toHaveLength(1);
  });

  it("creates nothing when the user says no", async () => {
    const w = world({}, { answers: ["deny"] });
    const result = await createSessionTool(w.env, w.caller, { title: "One", task: "a" }, signal());
    expect(result.isError).toBe(true);
    expect(w.created).toHaveLength(0);
  });

  it("refuses past the depth limit, without a card", async () => {
    const w = world({ depth: 3 }, { answers: ["allow_once"] });
    const result = await createSessionTool(w.env, w.caller, { title: "Deep", task: "a" }, signal());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("3 levels");
    expect(w.asked).toHaveLength(0);
  });

  it("refuses at the running limit, counting children still starting", async () => {
    const w = world({}, { settings: { maxRunningSpawned: 1, askBeforeCreate: false } });
    expect((await createSessionTool(w.env, w.caller, { title: "One", task: "a" }, signal())).isError).toBeUndefined();
    const second = await createSessionTool(w.env, w.caller, { title: "Two", task: "b" }, signal());
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain("already running");
  });

  it("never falls back to bypass: a parent whose mode is unknown creates nothing", async () => {
    const w = world({ mode: null }, { settings: { askBeforeCreate: false } });
    const result = await createSessionTool(w.env, w.caller, { title: "One", task: "a" }, signal());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("permission mode");
    expect(w.created).toHaveLength(0);

    // The provider's configured default is a mode the user chose: the child takes that.
    const configured = world({ mode: null }, { settings: { askBeforeCreate: false }, providerDefaultMode: "plan" });
    await createSessionTool(configured.env, configured.caller, { title: "One", task: "a" }, signal());
    expect(configured.deliveries[0]!.permissionMode).toBe("plan");
  });

  it("creates in the caller's own project only, and checks its arguments", async () => {
    const w = world({}, { settings: { askBeforeCreate: false } });
    expect((await createSessionTool(w.env, w.caller, { title: "x", task: "a", project: "other" }, signal())).isError).toBe(true);
    expect((await createSessionTool(w.env, w.caller, { task: "a" }, signal())).isError).toBe(true);
    expect((await createSessionTool(w.env, w.caller, { title: "x", task: " " }, signal())).isError).toBe(true);
    expect((await createSessionTool(w.env, w.caller, { title: "x", task: "a", provider: "gemini" }, signal())).isError).toBe(true);
    expect(w.created).toHaveLength(0);
    // Another provider does not inherit the parent's model.
    const ok = JSON.parse(textOf(await createSessionTool(w.env, w.caller, { title: "x", task: "a", provider: "codex" }, signal())));
    expect(ok).toMatchObject({ providerId: "codex", model: null });
  });

  it("waits for the child's reply when asked to", async () => {
    const w = world({}, { settings: { askBeforeCreate: false } });
    const pending = createSessionTool(w.env, w.caller, { title: "x", task: "a", wait: true }, signal());
    await new Promise((r) => setTimeout(r, 5));
    expect(w.env.waits.claimReply("child-session-1", PARENT, { text: "all done", sentAt: new Date(0).toISOString() })).toBe(true);
    const body = JSON.parse(textOf(await pending));
    expect(body.reply).toMatchObject({ replied: true, text: "all done" });
  });

  it("is not available to a design session", () => {
    const w = fakeEnv({ sessions: { [PARENT]: { providerId: "claude", projectPath: PROJECT_PATH, design: true } } });
    expect(resolveCaller(w.env, PARENT)).toMatchObject({ ok: false, refusal: "design_session" });
  });
});
