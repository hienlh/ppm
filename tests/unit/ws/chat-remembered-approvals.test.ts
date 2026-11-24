/**
 * Remembered approvals through the chat socket: a card offers "Allow & remember" with what it would
 * remember; a person's press makes the rule and the next request of that kind is approved with no
 * card, leaving one line in the chat. The Assistant's model, a script's loopback socket and a
 * switched-off feature never make a rule, and a session tool's card is approved by its rule too.
 */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../test-setup.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { chatControl } from "../../../src/services/chat-control/chat-control.ts";
import { chatLifecycle, type ChatLifecycleEvents } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { collabApprovalBroker } from "../../../src/services/session-collab/collab-approval-broker.ts";
import { configService } from "../../../src/services/config.service.ts";
import { rememberedApprovals } from "../../../src/services/remembered-approvals/remembered-approvals.service.ts";

const projectPath = mkdtempSync(join(tmpdir(), "ppm-remember-"));
let configBefore: { auth: unknown; projects: unknown; remembered: unknown };
const offs: Array<() => void> = [];
const shown: Array<ChatLifecycleEvents["approval_shown"]> = [];

beforeEach(() => {
  const config = (configService as any).config;
  configBefore = { auth: config.auth, projects: config.projects, remembered: config.remembered_approvals };
  config.auth = { ...config.auth, enabled: false };
  config.projects = [{ name: "app", path: projectPath }];
  config.remembered_approvals = { enabled: true };
  getDb().run("DELETE FROM approval_rules");
  getDb().run("DELETE FROM approval_pattern_tallies");
  shown.length = 0;
  offs.push(chatLifecycle.on("approval_shown", (p) => shown.push(p)));
});
afterEach(() => {
  const config = (configService as any).config;
  config.auth = configBefore.auth;
  config.projects = configBefore.projects;
  config.remembered_approvals = configBefore.remembered;
  for (const off of offs.splice(0)) off();
});

/** A chat of project "app" whose turn asks the provider's approvals in `requests`, one device showing it. */
async function chatAsking(requests: Array<{ requestId: string; command: string }>, socketData: Record<string, unknown> = {}) {
  const session = await chatService.createSession("mock", { projectName: "app", projectPath });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const resolved: Array<{ requestId: string; approved: boolean }> = [];
  const resolve = spyOn(chatService, "resolveApproval").mockImplementation((_p, _s, requestId, approved) => { resolved.push({ requestId, approved }); });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    for (const r of requests) yield { type: "approval_request", requestId: r.requestId, tool: "Bash", input: { command: r.command } } as any;
    await gate;
  });
  const messages: any[] = [];
  const socket = { data: { sessionId: session.id, projectName: "app", ...socketData }, send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(socket as any);
  await chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content: "go" }));
  for (let i = 0; i < 100 && !messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
  await Bun.sleep(20);
  const done = () => {
    collabApprovalBroker.cancelSession(session.id, "test over");
    release();
    send.mockRestore();
    resolve.mockRestore();
    chatWebSocket.close(socket as any);
  };
  return { session, socket, messages, resolved, done };
}

it("offers to remember a command, makes the rule on a person's press, then approves the same kind with no card", async () => {
  const first = await chatAsking([{ requestId: "r1", command: "git status" }]);
  try {
    const card = first.messages.find((m) => m.type === "approval_request" && m.requestId === "r1");
    expect(card.remember).toEqual({ label: "Run `git status`", suggest: false });
    await chatWebSocket.message(first.socket as any, JSON.stringify({ type: "approval_response", requestId: "r1", approved: true, remember: true }));
    expect(first.resolved).toEqual([{ requestId: "r1", approved: true }]);
    expect(rememberedApprovals.list().map((r) => [r.kind, r.pattern, r.createdVia])).toEqual([["command", "git status", "chat"]]);
  } finally {
    first.done();
  }

  const second = await chatAsking([{ requestId: "r2", command: "git status --short" }, { requestId: "r3", command: "git status; rm -rf x" }]);
  try {
    expect(second.resolved).toContainEqual({ requestId: "r2", approved: true });
    expect(second.messages.find((m) => m.type === "auto_approved")).toMatchObject({ requestId: "r2", label: "Run `git status`" });
    expect(second.messages.some((m) => m.type === "approval_request" && m.requestId === "r2")).toBe(false);
    // Joined to another command: never covered by the rule, so it asks.
    expect(second.messages.some((m) => m.type === "approval_request" && m.requestId === "r3")).toBe(true);
    expect(rememberedApprovals.list()[0]!.useCount).toBe(1);
  } finally {
    second.done();
  }
});

it("makes no rule for the Assistant's model, a script's socket, or a switched-off feature", async () => {
  const chat = await chatAsking([{ requestId: "a1", command: "ls" }]);
  try {
    expect(chatControl()!.answerApproval(chat.session.id, "a1", { approved: true, remember: true }, "assistant")).toBe("answered");
    expect(rememberedApprovals.list()).toEqual([]);
  } finally {
    chat.done();
  }

  const script = await chatAsking([{ requestId: "s1", command: "ls" }], { origin: "scheduler" });
  try {
    await chatWebSocket.message(script.socket as any, JSON.stringify({ type: "approval_response", requestId: "s1", approved: true, remember: true }));
    expect(rememberedApprovals.list()).toEqual([]);
  } finally {
    script.done();
  }

  (configService as any).config.remembered_approvals = { enabled: false };
  const off = await chatAsking([{ requestId: "o1", command: "ls" }]);
  try {
    expect(off.messages.find((m) => m.type === "approval_request" && m.requestId === "o1").remember).toBeUndefined();
    await chatWebSocket.message(off.socket as any, JSON.stringify({ type: "approval_response", requestId: "o1", approved: true, remember: true }));
    expect(rememberedApprovals.list()).toEqual([]);
  } finally {
    off.done();
  }
});

it("suggests remembering after the third approval of the same kind by hand", async () => {
  for (const [i, suggest] of [[1, false], [2, false], [3, false], [4, true]] as const) {
    const chat = await chatAsking([{ requestId: `t${i}`, command: "bun test tests/unit" }]);
    try {
      const card = chat.messages.find((m) => m.type === "approval_request" && m.requestId === `t${i}`);
      expect(card.remember).toEqual({ label: "Run `bun test`", suggest });
      await chatWebSocket.message(chat.socket as any, JSON.stringify({ type: "approval_response", requestId: `t${i}`, approved: true }));
    } finally {
      chat.done();
    }
  }
  expect(rememberedApprovals.list()).toEqual([]);
});

it("approves a session tool's card by its rule, with no card", async () => {
  const chat = await chatAsking([]);
  try {
    const ask = () => collabApprovalBroker.request(chat.session.id, { kind: "create", title: "Debug", providerId: "claude", model: null, task: "Look", depth: 1 }, undefined, 60_000);
    const first = ask();
    const card = shown.at(-1)!.card;
    expect(card.remember?.label).toBe("Open a new chat in this project");
    expect(chatControl()!.answerApproval(chat.session.id, card.requestId, { approved: true, remember: true }, "telegram")).toBe("answered");
    expect(await first).toEqual({ allowed: true, answer: "allow_once" });
    expect(rememberedApprovals.list().map((r) => [r.kind, r.createdVia])).toEqual([["collab:create", "telegram"]]);

    const before = shown.length;
    expect(await ask()).toEqual({ allowed: true, answer: "allow_once" });
    expect(shown.length).toBe(before);
    expect(chat.messages.find((m) => m.type === "auto_approved")?.label).toBe("Open a new chat in this project");
  } finally {
    chat.done();
  }
});
