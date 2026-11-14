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
import type { SendMessageOpts } from "../../../src/types/chat.ts";

let root: string;
let savedProjects: unknown;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-schedule-msg-"));
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "web", path: root }]);
});
afterAll(() => {
  configService.set("projects", savedProjects as never);
  rmSync(root, { recursive: true, force: true });
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
