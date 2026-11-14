/**
 * A session schedule's message through the chat door: it carries the schedule-run block in front
 * of the prompt, runs in the chat's own permission mode (a mode sent with it is refused, since it
 * would become the chat's sticky one), never goes into a busy chat, and the turn it opens is an
 * ordinary one whose approvals wait for the user instead of being refused.
 */
import { afterAll, afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../test-setup.ts";
import "../../../src/server/ws/chat.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { notificationService } from "../../../src/services/notification.service.ts";
import { CHAT_BUSY, chatControl, type ChatControl, type SendUserMessageOpts } from "../../../src/services/chat-control/chat-control.ts";
import type { ScheduleRunReference } from "../../../src/shared/chat-schedule-run.ts";
import { decodeMessageBlocks } from "../../../src/shared/chat-message-blocks.ts";
import { stripSharedContext } from "../../../src/shared/provider-context.ts";
import type { SendMessageOpts } from "../../../src/types/chat.ts";
import { chatLifecycle, type ChatLifecycleEvents } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { QueuedTurnsProvider } from "../../helpers/queued-turns-provider.ts";

let root: string;
let savedProjects: unknown;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-schedule-msg-"));
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "web", path: root }]);
});
afterAll(async () => {
  configService.set("projects", savedProjects as never);
  // Retried: on Windows the work a chat starts in its project once a turn ends holds the folder
  // for a moment after the last test.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EBUSY" || attempt >= 40) throw e;
      await Bun.sleep(100);
    }
  }
});

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

const ctl = (): ChatControl => {
  const c = chatControl();
  if (!c) throw new Error("the chat socket layer registered no chat control");
  return c;
};

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const run: ScheduleRunReference = {
  version: 1, scheduleId: 3, name: "Nightly", cron: "0 2 * * *", timezone: null,
  scheduledFor: "2026-11-16T19:00:00.000Z", firedAt: "2026-11-16T19:00:01.000Z", catchUp: false, coalesced: false,
};
const opts = (over: Partial<SendUserMessageOpts> = {}): SendUserMessageOpts =>
  ({ origin: "schedule", projectName: "web", providerId: "mock", scheduleRun: run, ...over });

/** The mock provider's turns, held at `gate` until it is opened. */
function script() {
  const turns: Array<{ content: string; opts?: SendMessageOpts }> = [];
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const provider = providerRegistry.get("mock")!;
  const send = spyOn(provider, "sendMessage").mockImplementation((async function* (sessionId: string, content: string, o?: SendMessageOpts) {
    turns.push({ content, opts: o });
    yield { type: "text", content: "on it" };
    yield { type: "approval_request", requestId: "req-sched", tool: "Bash", input: { command: "ls" } };
    await gate;
    yield { type: "done", sessionId };
  }) as never);
  restores.push(() => { open(); send.mockRestore(); });
  return { turns, open: () => open() };
}

async function newChat(): Promise<string> {
  return (await chatService.createSession("mock", { projectName: "web", projectPath: root })).id;
}

it("refuses a permission mode or a missing run, and a run on any other origin", async () => {
  const id = await newChat();
  expect(await ctl().sendUserMessage(id, "go", opts({ permissionMode: "bypassPermissions" })))
    .toEqual({ ok: false, error: "A scheduled run uses the chat's own permission mode." });
  expect((await ctl().sendUserMessage(id, "go", opts({ scheduleRun: undefined }))).ok).toBe(false);
  expect((await ctl().sendUserMessage(id, "go", opts({ scheduleRun: { ...run, version: 2 as never } }))).ok).toBe(false);
  expect((await ctl().sendUserMessage(id, "go", { origin: "telegram", projectName: "web", providerId: "mock", scheduleRun: run })).ok).toBe(false);
});

it("opens a turn of its own with the run in front of the prompt, and shows its approvals", async () => {
  const provider = script();
  const id = await newChat();
  const notified: string[] = [];
  const spy = spyOn(notificationService, "broadcast").mockImplementation(((type: string) => { notified.push(type); }) as never);
  restores.push(() => spy.mockRestore());
  const resolved = spyOn(chatService, "resolveApproval");
  restores.push(() => resolved.mockRestore());

  const result = await ctl().sendUserMessage(id, "Check the nightly build", opts({ clientMessageId: "schedule-abc" }));
  expect(result).toEqual({ ok: true, sessionId: id, delivered: "started" });
  await until(() => provider.turns.length === 1, "the scheduled turn");

  const sent = provider.turns[0]!;
  expect(sent.content.startsWith("<ppm-schedule-run-v1>\n")).toBe(true);
  expect(decodeMessageBlocks(sent.content)).toMatchObject({ content: "Check the nightly build", scheduleRun: run });
  expect(sent.opts?.permissionMode).toBeUndefined();

  await until(() => !!ctl().liveState(id)?.card, "the approval card");
  expect(ctl().liveState(id)?.turnOrigin).toBe("schedule");
  // Shown and waiting for the user, never refused on their behalf.
  expect(resolved).not.toHaveBeenCalled();
  expect(notified).toContain("approval_request");

  // A second scheduled message finds the chat busy rather than steering the turn or the card.
  expect(await ctl().sendUserMessage(id, "again", opts())).toEqual({ ok: false, error: CHAT_BUSY });
  expect(provider.turns).toHaveLength(1);
});

/** `fake` answers as provider `id` until the test ends; the real one (if any) comes back after. */
function standIn(id: string, fake: QueuedTurnsProvider & { listSkills?: () => Promise<Array<{ name: string }>> }): QueuedTurnsProvider {
  const real = providerRegistry.get(id);
  providerRegistry.register(fake);
  restores.push(() => {
    if (real) providerRegistry.register(real);
    else (providerRegistry as unknown as { providers: Map<string, unknown> }).providers.delete(id);
  });
  return fake;
}

it("keeps a scheduled slash command first for Claude, with the run after it", async () => {
  const claude = standIn("claude", new QueuedTurnsProvider("claude"));
  const id = (await chatService.createSession("claude", { projectName: "web", projectPath: root })).id;
  expect((await ctl().sendUserMessage(id, "/review-pr 42", opts({ providerId: "claude" }))).ok).toBe(true);
  await until(() => claude.queries.length === 1, "the scheduled turn");
  const sent = claude.queries[0]!.message;
  // First, with nothing in front: not even PPM's shared context, which a slash command never gets.
  expect(sent.startsWith("/review-pr 42\n\n<ppm-schedule-run-v1>\n")).toBe(true);
  expect(decodeMessageBlocks(sent)).toMatchObject({ content: "/review-pr 42", scheduleRun: run });
  claude.abortQuery(id);
});

it("sends a scheduled skill to Codex as its `$name` mention with the run in front", async () => {
  const fake = Object.assign(new QueuedTurnsProvider("codex"), { listSkills: async () => [{ name: "review-pr" }] });
  const codex = standIn("codex", fake);
  const id = (await chatService.createSession("codex", { projectName: "web", projectPath: root })).id;
  expect((await ctl().sendUserMessage(id, "/review-pr 42", opts({ providerId: "codex" }))).ok).toBe(true);
  await until(() => codex.queries.length === 1, "the scheduled turn");
  // PPM puts its shared context in front of a message that is not a slash command.
  const sent = stripSharedContext(codex.queries[0]!.message);
  expect(sent.startsWith("<ppm-schedule-run-v1>\n")).toBe(true);
  expect(decodeMessageBlocks(sent)).toMatchObject({ content: "$review-pr 42", scheduleRun: run });
  codex.abortQuery(id);
});

it("leaves a prompt that is not a command as it was, the run in front, for Claude too", async () => {
  const claude = standIn("claude", new QueuedTurnsProvider("claude"));
  const id = (await chatService.createSession("claude", { projectName: "web", projectPath: root })).id;
  expect((await ctl().sendUserMessage(id, "Check the nightly build", opts({ providerId: "claude" }))).ok).toBe(true);
  await until(() => claude.queries.length === 1, "the scheduled turn");
  const sent = stripSharedContext(claude.queries[0]!.message);
  expect(sent.startsWith("<ppm-schedule-run-v1>\n")).toBe(true);
  expect(sent.endsWith("\n\nCheck the nightly build")).toBe(true);
  claude.abortQuery(id);
});

it("says a builtin answered inside a running turn left that turn running", async () => {
  const held = new QueuedTurnsProvider("schedule-builtin-mid-turn");
  providerRegistry.register(held);
  const id = (await chatService.createSession(held.id, { projectName: "web", projectPath: root })).id;
  const ends: Array<ChatLifecycleEvents["turn_ended"]> = [];
  const off = chatLifecycle.on("turn_ended", (p) => { if (p.sessionId === id) ends.push(p); });
  restores.push(off);

  expect((await ctl().sendUserMessage(id, "hold:the run", opts({ providerId: held.id }))).ok).toBe(true);
  await until(() => !!ctl().liveState(id)?.running, "the scheduled turn");
  expect((await ctl().sendUserMessage(id, "/version", { origin: "telegram", projectName: "web", providerId: held.id })).ok).toBe(true);
  expect(ends).toHaveLength(1);
  expect(ends[0]!.turnStillRunning).toBe(true);
  expect(ctl().liveState(id)?.running).toBe(true);

  await until(() => (held as unknown as { holds: Map<string, unknown> }).holds.has(id), "the turn to hold");
  held.release(id);

  await until(() => ends.length === 2, "the scheduled turn's own end");
  expect(ends[1]!.turnStillRunning).toBeUndefined();
  held.abortQuery(id);
});

it("lets a watch report and a scheduled message in one at a time, never into one turn", async () => {
  const slow = new QueuedTurnsProvider("schedule-and-watch");
  providerRegistry.register(slow);
  const id = (await chatService.createSession(slow.id, { projectName: "web", projectPath: root })).id;
  let resume!: () => void;
  slow.resumeHold = new Promise<void>((r) => { resume = r; });

  // The scheduled message is still resuming the cold session when the watch report checks in.
  const scheduled = ctl().sendUserMessage(id, "the scheduled prompt", opts({ providerId: slow.id }));
  await Bun.sleep(20);
  // Bounded: a watch report let through waits behind the scheduled one's resume instead.
  const watch = await Promise.race([
    ctl().sendUserMessage(id, "watch news", {
      origin: "watch", projectName: "web", providerId: slow.id,
      watchEvents: [{ watchId: "w1", kind: "done", project: "web", sessionId: "watched", providerId: slow.id, title: "Watched", at: Date.now() }],
    }),
    Bun.sleep(1_000).then(() => "still waiting" as const),
  ]);
  expect(watch).toEqual({ ok: false, error: CHAT_BUSY });

  resume();
  expect((await scheduled).ok).toBe(true);
  await until(() => slow.queries.length === 1, "the scheduled turn");
  expect(slow.queries[0]!.message).toContain("the scheduled prompt");
  expect(slow.pushes).toHaveLength(0);
  slow.abortQuery(id);
});
