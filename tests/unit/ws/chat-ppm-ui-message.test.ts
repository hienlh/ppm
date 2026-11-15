/**
 * PPM's own message door (`ppm_ui`, PPM Tasks): it opens an ordinary turn in a quiet chat, never
 * answers a card on screen and never steers a running turn — behind one it waits for that turn to
 * end — and it leaves no PPM screen as "the chatting device".
 */
import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../test-setup.ts";
import { deliverToChattingDevice } from "../../../src/server/ws/chat.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { chatControl, isUnattendedTurn, type ChatControl } from "../../../src/services/chat-control/chat-control.ts";
import { QueuedTurnsProvider, until } from "../../helpers/queued-turns-provider.ts";

let root: string;
let savedProjects: unknown;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-ppm-ui-msg-"));
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "web", path: root }]);
});
afterAll(async () => {
  configService.set("projects", savedProjects as never);
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

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

const ctl = (): ChatControl => {
  const c = chatControl();
  if (!c) throw new Error("the chat socket layer registered no chat control");
  return c;
};

function provider(id: string): QueuedTurnsProvider {
  const p = new QueuedTurnsProvider(id);
  providerRegistry.register(p);
  return p;
}

it("opens an ordinary turn in a quiet chat and reports it started", async () => {
  const p = provider("ppm-ui-quiet");
  const id = (await chatService.createSession(p.id, { projectName: "web", projectPath: root })).id;
  cleanups.push(() => p.abortQuery(id));
  const result = await ctl().sendUserMessage(id, 'Decision on web/3 "Pension": B — Weekly', { origin: "ppm_ui", projectName: "web", providerId: p.id });
  expect(result).toEqual({ ok: true, sessionId: id, delivered: "started" });
  await until(() => p.queries.length === 1, "the turn");
  expect(p.queries[0]!.message).toContain('Decision on web/3 "Pension": B — Weekly');
  expect(ctl().liveState(id)?.turnOrigin).toBe("ppm_ui");
  expect(isUnattendedTurn(id)).toBe(false);
  // No PPM screen sent it: the screen tools have no device to drive.
  expect(deliverToChattingDevice(id, { type: "probe" }, { strict: true })).toBe(0);
});

it("waits behind a turn showing a card, answering nothing, then runs as its own turn", async () => {
  const p = provider("ppm-ui-card");
  const id = (await chatService.createSession(p.id, { projectName: "web", projectPath: root })).id;
  cleanups.push(() => p.abortQuery(id));
  expect((await ctl().sendUserMessage(id, "ask:delete the build", { origin: "telegram", projectName: "web", providerId: p.id })).ok).toBe(true);
  await until(() => !!ctl().liveState(id)?.card, "the approval card");
  const card = ctl().liveState(id)!.card!;

  const result = await ctl().sendUserMessage(id, "Decision on #1: A — Keep", { origin: "ppm_ui", projectName: "web", providerId: p.id });
  expect(result).toEqual({ ok: true, sessionId: id, delivered: "queued" });
  expect(p.approvalAnswers).toEqual([]);
  expect(ctl().liveState(id)?.card?.requestId).toBe(card.requestId);
  // The turn that asked is still the person's.
  expect(ctl().liveState(id)?.turnOrigin).toBe("telegram");

  expect(ctl().answerApproval(id, card.requestId, { approved: true }, "telegram")).toBe("answered");
  await until(() => p.pushes.some((x) => x.content.includes("Decision on #1: A — Keep")), "the queued message");
  await until(() => ctl().liveState(id)?.turnOrigin === "ppm_ui", "the message's own turn");
  expect(p.approvalAnswers).toEqual([{ requestId: card.requestId, approved: true }]);
});

it("refuses a ppm_ui message carrying another door's extras", async () => {
  const p = provider("ppm-ui-extras");
  const id = (await chatService.createSession(p.id, { projectName: "web", projectPath: root })).id;
  const res = await ctl().sendUserMessage(id, "x", { origin: "ppm_ui", projectName: "web", providerId: p.id, wakeNews: [] });
  expect(res.ok).toBe(false);
});
