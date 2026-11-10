import { describe, expect, it } from "bun:test";
import { sendToSessionTool } from "../../../src/services/session-collab/collab-send.ts";
import { resolveCaller } from "../../../src/services/session-collab/collab-context.ts";
import { fakeEnv, OTHER_PATH, PROJECT_PATH, textOf, type FakeSession } from "./session-collab-fake-env.ts";

const A = "session-aaaa";
const B = "session-bbbb";
const signal = () => new AbortController().signal;

function world(target: Partial<FakeSession> = {}, opts: Omit<Parameters<typeof fakeEnv>[0], "sessions"> = {}, sender: Partial<FakeSession> = {}) {
  const fake = fakeEnv({
    sessions: {
      [A]: { providerId: "claude", projectPath: PROJECT_PATH, title: "Sender", mode: "acceptEdits", ...sender },
      [B]: { providerId: "codex", projectPath: PROJECT_PATH, title: "Target", mode: "acceptEdits", ...target },
    },
    ...opts,
  });
  const caller = resolveCaller(fake.env, A);
  if (!caller.ok) throw new Error(caller.message);
  return { ...fake, caller: caller.value };
}

describe("send_to_session", () => {
  it("delivers into a session of the same project, as a message from the sender", async () => {
    const w = world({}, { delivered: "inserted" });
    const body = JSON.parse(textOf(await sendToSessionTool(w.env, w.caller, { session_id: B, message: "status?" }, signal())));
    expect(body).toMatchObject({ delivered: "inserted", status: { sessionId: B, providerId: "codex" } });
    expect(w.deliveries[0]).toMatchObject({ targetSessionId: B, providerId: "codex", body: "status?" });
    expect(w.asked).toHaveLength(0);
  });

  it("refuses itself, another project, a design session and an unknown session", async () => {
    const self = world();
    expect(textOf(await sendToSessionTool(self.env, self.caller, { session_id: A, message: "x" }, signal()))).toContain("own session");
    const other = world({ projectPath: OTHER_PATH });
    expect(textOf(await sendToSessionTool(other.env, other.caller, { session_id: B, message: "x" }, signal()))).toContain("another project");
    const design = world({ design: true });
    expect(textOf(await sendToSessionTool(design.env, design.caller, { session_id: B, message: "x" }, signal()))).toContain("design session");
    const unknown = world();
    expect(textOf(await sendToSessionTool(unknown.env, unknown.caller, { session_id: "session-zzzz", message: "x" }, signal()))).toContain("No PPM session");
    for (const w of [self, other, design, unknown]) expect(w.deliveries).toHaveLength(0);
  });

  it("refuses a session PPM has no project record for and that is not open, such as one in a terminal", async () => {
    // Known to the provider only (no project row, no registry entry): never resumed from here.
    const w = world({ projectPath: undefined, live: null });
    const result = await sendToSessionTool(w.env, w.caller, { session_id: B, message: "x" }, signal());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PPM did not open");
    expect(w.deliveries).toHaveLength(0);
    // The same session open in PPM's registry is reachable.
    const open = world({ projectPath: undefined, live: { projectPath: PROJECT_PATH } });
    expect((await sendToSessionTool(open.env, open.caller, { session_id: B, message: "x" }, signal())).isError).toBeUndefined();
  });

  it("refuses a message over the byte limit with a clear reason", async () => {
    const w = world();
    const result = await sendToSessionTool(w.env, w.caller, { session_id: B, message: "😀".repeat(7_000) }, signal());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("at most 24 KB");
    expect(w.deliveries).toHaveLength(0);
  });

  it("counts each message in the same step as the limit check, so sends arriving together cannot overshoot it", async () => {
    const w = world({}, { settings: { maxAutoMessagesPerPair: 1 }, answers: ["deny", "deny"] });
    const results = await Promise.all(["m1", "m2", "m3"].map((m) => sendToSessionTool(w.env, w.caller, { session_id: B, message: m }, signal())));
    expect(w.deliveries.map((d) => d.body)).toEqual(["m1"]);
    expect(results.filter((r) => r.isError === true)).toHaveLength(2);
    expect(w.asked.map((a) => a.kind)).toEqual(["pair_limit", "pair_limit"]);
    expect(w.env.pairs.count(A, B)).toBe(1);
  });

  it("does not count a message the user refused or that was never delivered", async () => {
    const w = world({ mode: "bypassPermissions" }, { answers: ["deny"] }, { mode: "default" });
    await sendToSessionTool(w.env, w.caller, { session_id: B, message: "x" }, signal());
    expect(w.env.pairs.count(A, B)).toBe(0);

    const failing = world();
    failing.env.deliver = async () => { throw new Error("The session closed"); };
    const result = await sendToSessionTool(failing.env, failing.caller, { session_id: B, message: "x" }, signal());
    expect(result.isError).toBe(true);
    expect(failing.env.pairs.count(A, B)).toBe(0);
  });

  it("asks at the pair limit; allowing grants the limit again, denying sends nothing", async () => {
    const w = world({}, { settings: { maxAutoMessagesPerPair: 2 }, answers: ["allow_once", "deny"] });
    for (let i = 0; i < 2; i++) await sendToSessionTool(w.env, w.caller, { session_id: B, message: `m${i}` }, signal());
    expect(w.asked).toHaveLength(0);
    await sendToSessionTool(w.env, w.caller, { session_id: B, message: "m2" }, signal());
    expect(w.asked[0]).toMatchObject({ kind: "pair_limit", sent: 2, limit: 2, grant: 2 });
    expect(w.deliveries).toHaveLength(3);
    // The grant covers m2 and m3; m4 asks again and is denied.
    await sendToSessionTool(w.env, w.caller, { session_id: B, message: "m3" }, signal());
    expect(w.asked).toHaveLength(1);
    const denied = await sendToSessionTool(w.env, w.caller, { session_id: B, message: "m4" }, signal());
    expect(denied.isError).toBe(true);
    expect(w.asked).toHaveLength(2);
    expect(w.deliveries).toHaveLength(4);
  });

  it("asks before reaching a more permissive session, showing the whole message, and remembers Allow for this session", async () => {
    const w = world({ mode: "bypassPermissions" }, { answers: ["allow_session"] }, { mode: "default" });
    const message = `first do the harmless part\n\n${"x".repeat(400)}\nthen run the migration`;
    await sendToSessionTool(w.env, w.caller, { session_id: B, message }, signal());
    await sendToSessionTool(w.env, w.caller, { session_id: B, message: "again" }, signal());
    expect(w.asked).toEqual([{
      kind: "escalation", targetSessionId: B, targetTitle: "Target", senderMode: "default", targetMode: "bypassPermissions", message,
    }]);
    expect(w.deliveries).toHaveLength(2);

    // A target given no mode runs its provider's fallback, bypass.
    const unset = world({ mode: null }, { answers: ["deny"] }, { mode: "plan" });
    const result = await sendToSessionTool(unset.env, unset.caller, { session_id: B, message: "x" }, signal());
    expect(result.isError).toBe(true);
    expect(unset.asked[0]).toMatchObject({ kind: "escalation", targetMode: "bypassPermissions" });
    expect(unset.deliveries).toHaveLength(0);

    // A target whose mode PPM cannot tell counts as the most permissive.
    const unknown = world({ mode: "notAMode" }, { answers: ["deny"] }, { mode: "acceptEdits" });
    await sendToSessionTool(unknown.env, unknown.caller, { session_id: B, message: "x" }, signal());
    expect(unknown.asked[0]).toMatchObject({ kind: "escalation", targetMode: "notAMode" });
    expect(unknown.deliveries).toHaveLength(0);
  });

  it("asks again once the allowed target switches to a mode with more rights than when it was allowed", async () => {
    const w = world({ mode: "acceptEdits" }, { answers: ["allow_session", "deny"] }, { mode: "plan" });
    await sendToSessionTool(w.env, w.caller, { session_id: B, message: "one" }, signal());
    await sendToSessionTool(w.env, w.caller, { session_id: B, message: "two" }, signal());
    expect(w.asked).toHaveLength(1);
    const stored = w.env.storedPermissionMode;
    w.env.storedPermissionMode = (id) => (id === B ? "bypassPermissions" : stored(id));
    const refused = await sendToSessionTool(w.env, w.caller, { session_id: B, message: "three" }, signal());
    expect(refused.isError).toBe(true);
    expect(w.asked).toHaveLength(2);
    expect(w.asked[1]).toMatchObject({ kind: "escalation", targetMode: "bypassPermissions" });
    expect(w.deliveries.map((d) => d.body)).toEqual(["one", "two"]);
  });

  it("hands a reply to the session waiting for it instead of delivering it again", async () => {
    const w = world();
    const begun = w.env.waits.begin({ waiter: B, target: A, timeoutMs: 60_000 });
    if (!begun.ok) throw new Error(begun.message);
    const result = JSON.parse(textOf(await sendToSessionTool(w.env, w.caller, { session_id: B, message: "here it is" }, signal())));
    expect(result.delivered).toBe("inserted");
    expect(await begun.wait.outcome).toMatchObject({ replied: true, text: "here it is" });
    expect(w.deliveries).toHaveLength(0);
    // The next message finds no wait: it is a new message.
    await sendToSessionTool(w.env, w.caller, { session_id: B, message: "one more" }, signal());
    expect(w.deliveries).toHaveLength(1);
  });

  it("waits for a reply, and reports the target's status when its turn ends without one", async () => {
    const w = world();
    const pending = sendToSessionTool(w.env, w.caller, { session_id: B, message: "check", wait: true }, signal());
    await new Promise((r) => setTimeout(r, 5));
    w.env.waits.turnBound("session-1");
    w.env.waits.turnEnded(B);
    const body = JSON.parse(textOf(await pending));
    expect(body.reply).toEqual({ replied: false, reason: "turn_ended_without_reply" });
    expect(body.status.sessionId).toBe(B);
  });
});
