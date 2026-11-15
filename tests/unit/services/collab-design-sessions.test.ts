import { describe, expect, it } from "bun:test";
import { createSessionTool } from "../../../src/services/session-collab/collab-create.ts";
import { sendToSessionTool } from "../../../src/services/session-collab/collab-send.ts";
import { designShotTool } from "../../../src/services/session-collab/collab-design-shot.ts";
import { resolveCaller } from "../../../src/services/session-collab/collab-context.ts";
import { MAX_DESIGN_ANSWER_CHARS } from "../../../src/services/session-collab/collab-deliver.ts";
import type { CapturedShot } from "../../../src/services/design/shots/design-shots.service.ts";
import { fakeEnv, OTHER_PATH, PROJECT_PATH, textOf, type FakeSession } from "./session-collab-fake-env.ts";

/**
 * Design chats through the session tools: an ordinary chat opens one for an existing design,
 * messages it, and gets its answer back as the reply (it has no send_to_session of its own);
 * `design_screenshot` renders the design's variants.
 */

const PARENT = "parent-session";
const DESIGN_CHAT = "design-session";
const ASSISTANT = "assistant-session";
const signal = () => new AbortController().signal;

function world(sessions: Record<string, FakeSession> = {}, opts: Omit<Parameters<typeof fakeEnv>[0], "sessions"> = {}, callerId = PARENT) {
  const fake = fakeEnv({
    sessions: {
      [PARENT]: { providerId: "claude", projectPath: PROJECT_PATH, title: "Parent", mode: "acceptEdits", model: "opus" },
      ...sessions,
    },
    designs: { "kho-task": "Kho task" },
    ...opts,
  });
  const caller = resolveCaller(fake.env, callerId);
  if (!caller.ok) throw new Error(caller.message);
  return { ...fake, caller: caller.value };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("create_session with a design", () => {
  it("opens a Design chat for the design, in the creator's mode, and shows the design on the card", async () => {
    const w = world({}, { answers: ["allow_once"] });
    const result = await createSessionTool(w.env, w.caller, { title: "Kho task UI", task: "Make 3 variants", design: "kho-task" }, signal());
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(textOf(result));
    expect(body).toMatchObject({ sessionId: "child-session-1", design: "kho-task" });
    expect(w.asked[0]).toMatchObject({ kind: "create", design: { slug: "kho-task", title: "Kho task" }, permissionMode: "acceptEdits" });
    // The slug is what makes it a Design chat; never a mode looser than the creator's.
    expect(w.env.isDesignSession("child-session-1")).toBe(true);
    expect(w.deliveries[0]).toMatchObject({ targetSessionId: "child-session-1", body: "Make 3 variants", permissionMode: "acceptEdits" });
    // It has no send_to_session: it is told to answer in its reply, and given no turn link it cannot follow.
    expect(w.deliveries[0]!.fromSession).toMatchObject({ sessionId: PARENT, replyVia: "answer" });
    expect(w.deliveries[0]!.turnRefs).toBeUndefined();
  });

  it("refuses a design the project does not have, an invalid slug, design with manager, and a provider that cannot run one", async () => {
    const w = world({}, { answers: ["allow_once"], designProviders: ["claude"] });
    const missing = await createSessionTool(w.env, w.caller, { title: "x", task: "y", design: "nope" }, signal());
    expect(textOf(missing)).toContain('has no design "nope"');
    const bad = await createSessionTool(w.env, w.caller, { title: "x", task: "y", design: "../etc" }, signal());
    expect(textOf(bad)).toContain("slug");
    const both = await createSessionTool(w.env, w.caller, { design: "kho-task", manager: true }, signal());
    expect(textOf(both)).toContain("cannot go together");
    const codex = await createSessionTool(w.env, w.caller, { title: "x", task: "y", design: "kho-task", provider: "codex" }, signal());
    expect(textOf(codex)).toContain("cannot run a Design chat");
    expect(w.created).toHaveLength(0);
    expect(w.asked).toHaveLength(0);
  });

  it("lets the PPM Assistant open a Design chat in the project it names, asking every time", async () => {
    const w = world({ [ASSISTANT]: { providerId: "claude", projectPath: "/assistant", title: "Assistant" } }, {
      answers: ["allow_once"], assistants: [ASSISTANT],
    }, ASSISTANT);
    const result = await createSessionTool(w.env, w.caller, { title: "Kho", task: "Brief", design: "kho-task", project: "app" }, signal());
    expect(result.isError).toBeUndefined();
    expect(w.asked[0]).toMatchObject({ askedBy: "assistant", design: { slug: "kho-task" }, projectName: "app" });
    expect(w.env.isDesignSession("child-session-1")).toBe(true);
  });
});

describe("send_to_session to a Design chat", () => {
  const sessions: Record<string, FakeSession> = {
    [DESIGN_CHAT]: { providerId: "claude", projectPath: PROJECT_PATH, title: "Design", mode: "acceptEdits", design: true, live: {} },
  };

  it("delivers, and a wait hands back the answer of the turn that took the message", async () => {
    const own = structuredClone(sessions);
    const w = world(own);
    const pending = sendToSessionTool(w.env, w.caller, { session_id: DESIGN_CHAT, message: "Variant 2, darker", wait: true }, signal());
    await tick();
    expect(w.deliveries[0]!.fromSession).toMatchObject({ replyVia: "answer" });
    w.env.waits.turnBound("session-1");
    // The turn that took the message (client id session-1) ends with its answer.
    setAnswer(own, "Done: variant-2.html is darker. ```hidden```", ["session-1"]);
    w.env.waits.turnEnded(DESIGN_CHAT);
    const body = JSON.parse(textOf(await pending));
    expect(body.reply).toMatchObject({ replied: true });
    expect(body.reply.text).toContain("variant-2.html is darker");
    expect(body.reply.text).not.toContain("```");
  });

  it("does not hand back another turn's answer when the turn that took the message gave none", async () => {
    const own = structuredClone(sessions);
    const w = world(own);
    // The answer on record is the user's own turn, which the message waited behind.
    setAnswer(own, "an answer to the user's own turn", ["browser-message-1"]);
    const pending = sendToSessionTool(w.env, w.caller, { session_id: DESIGN_CHAT, message: "go", wait: true }, signal());
    await tick();
    w.env.waits.turnBound("session-1");
    w.env.waits.turnEnded(DESIGN_CHAT);
    const body = JSON.parse(textOf(await pending));
    expect(body.reply).toEqual({ replied: false, reason: "turn_ended_without_reply" });
  });

  it("cuts a long answer to the message limit", async () => {
    const own = structuredClone(sessions);
    const w = world(own);
    const pending = sendToSessionTool(w.env, w.caller, { session_id: DESIGN_CHAT, message: "go", wait: true }, signal());
    await tick();
    w.env.waits.turnBound("session-1");
    setAnswer(own, "x".repeat(MAX_DESIGN_ANSWER_CHARS + 500), ["session-1"]);
    w.env.waits.turnEnded(DESIGN_CHAT);
    const body = JSON.parse(textOf(await pending));
    expect(body.reply.text.length).toBe(MAX_DESIGN_ANSWER_CHARS + 1);
  });

  it("still keeps a design chat from calling the tools itself", () => {
    const w = fakeEnv({ sessions: structuredClone(sessions) });
    expect(resolveCaller(w.env, DESIGN_CHAT)).toMatchObject({ ok: false, refusal: "design_session" });
  });
});

describe("design_screenshot", () => {
  const shot = (id: string, file: string): CapturedShot => ({
    id, projectPath: PROJECT_PATH, slug: "kho-task", designTitle: "Kho task", file, label: "", width: 1280, height: 900,
    createdAt: new Date().toISOString(), png: new Uint8Array([137, 80, 78, 71]),
  });

  function shotWorld(callerId = PARENT, extra: Record<string, FakeSession> = {}, opts: Omit<Parameters<typeof fakeEnv>[0], "sessions"> = {}) {
    const w = world(extra, opts, callerId);
    const calls: Array<{ path: string; slug: string; variants?: string[] }> = [];
    w.env.captureDesignShots = async (path, slug, variants) => {
      calls.push({ path, slug, variants });
      return [shot("a".repeat(32), "index.html"), shot("b".repeat(32), "variant-2.html")];
    };
    w.env.shotLink = async (id) => `https://ppm.example/api/design-shots/${id}.png`;
    return { ...w, calls };
  }

  it("renders the caller's own project's design and returns ids, links and the pictures", async () => {
    const w = shotWorld();
    const result = await designShotTool(w.env, w.caller, { design: "kho-task" });
    expect(result.isError).toBeUndefined();
    const content = result.content as Array<{ type: string; text?: string; mimeType?: string }>;
    const listed = JSON.parse(content[0]!.text!);
    expect(listed.shots.map((s: { id: string }) => s.id)).toEqual(["a".repeat(32), "b".repeat(32)]);
    expect(listed.shots[0].link).toBe(`https://ppm.example/api/design-shots/${"a".repeat(32)}.png`);
    expect(content.filter((c) => c.type === "image").every((c) => c.mimeType === "image/png")).toBe(true);
    expect(w.calls).toEqual([{ path: PROJECT_PATH, slug: "kho-task", variants: undefined }]);
  });

  it("refuses another project for a session, and needs a project from the Assistant", async () => {
    const w = shotWorld();
    expect(textOf(await designShotTool(w.env, w.caller, { design: "kho-task", project: "other" }))).toContain("own project");
    const a = shotWorld(ASSISTANT, { [ASSISTANT]: { providerId: "claude", projectPath: "/assistant" } }, { assistants: [ASSISTANT] });
    expect(textOf(await designShotTool(a.env, a.caller, { design: "kho-task" }))).toContain("`project` is required");
    await designShotTool(a.env, a.caller, { design: "kho-task", project: "other" });
    expect(a.calls[0]!.path).toBe(OTHER_PATH);
    expect(w.calls).toHaveLength(0);
  });

  it("reports why no picture was taken", async () => {
    const w = shotWorld();
    w.env.captureDesignShots = async () => { throw new Error("No Chrome, Edge or Chromium was found"); };
    const result = await designShotTool(w.env, w.caller, { design: "kho-task" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No Chrome");
  });
});

/** Puts `text` as the Design chat's last answer, from the turn that took `clientMessageIds`, as the chat registry keeps it. */
function setAnswer(own: Record<string, FakeSession>, text: string, clientMessageIds: string[]): void {
  own[DESIGN_CHAT]!.live = { ...own[DESIGN_CHAT]!.live, lastFullAnswer: { text, at: Date.now(), clientMessageIds } };
}
