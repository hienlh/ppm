/**
 * A chat that is not the PPM Assistant's, showing a session tool's card (the user's own chat asking
 * to open a Design chat): the card reaches the server-side listeners with its deadline, so the
 * Assistant's "Waiting on you" and Telegram can carry it; a press on Telegram or on the Assistant's
 * mirror settles it once; the Assistant's model cannot; running out of time is told as "expired".
 * A `db_execute` card is only named to them, never shown.
 */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { chatControl } from "../../../src/services/chat-control/chat-control.ts";
import { chatLifecycle, type ChatLifecycleEvents } from "../../../src/services/chat-control/chat-lifecycle.ts";
import { collabApprovalBroker } from "../../../src/services/session-collab/collab-approval-broker.ts";
import { dbApprovalBroker } from "../../../src/services/db-ai-tools/db-approval-broker.ts";
import { configService } from "../../../src/services/config.service.ts";
import type { SessionCollabApprovalInput } from "../../../src/shared/session-collab.ts";

const DESIGN: SessionCollabApprovalInput = {
  kind: "create", title: "Design kho task", providerId: "claude", model: null, task: "Make the kho task design", depth: 1,
};

let authBefore: unknown;
const offs: Array<() => void> = [];
const shown: Array<ChatLifecycleEvents["approval_shown"]> = [];
const named: Array<ChatLifecycleEvents["ppm_only_card_shown"]> = [];
const ended: Array<ChatLifecycleEvents["approval_resolved"]> = [];

beforeEach(() => {
  const config = (configService as any).config;
  authBefore = config.auth;
  config.auth = { ...config.auth, enabled: false };
  shown.length = 0; named.length = 0; ended.length = 0;
  offs.push(
    chatLifecycle.on("approval_shown", (p) => shown.push(p)),
    chatLifecycle.on("ppm_only_card_shown", (p) => named.push(p)),
    chatLifecycle.on("approval_resolved", (p) => ended.push(p)),
  );
});
afterEach(() => {
  (configService as any).config.auth = authBefore;
  for (const off of offs.splice(0)) off();
});

/** An ordinary chat whose turn is under way, with one device showing it. */
async function chatWaiting() {
  const session = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const messages: any[] = [];
  const socket = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(socket as any);
  await chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content: "make the design" }));
  for (let i = 0; i < 100 && !messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);
  const done = () => {
    collabApprovalBroker.cancelSession(session.id, "test over");
    dbApprovalBroker.cancelSession(session.id, "test over");
    release();
    send.mockRestore();
    chatWebSocket.close(socket as any);
  };
  return { session, done };
}

it("tells the listeners an ordinary chat's session-tool card, with its deadline, and settles it from a Telegram press", async () => {
  const { session, done } = await chatWaiting();
  try {
    const before = Date.now();
    const outcome = collabApprovalBroker.request(session.id, DESIGN, undefined, 60_000);
    const card = shown.find((s) => s.sessionId === session.id)?.card;
    expect(card?.tool).toBe("ppm:session_collab");
    expect(card!.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    // The live card a surface reads later carries the same deadline.
    expect(chatControl()!.liveState(session.id)?.card?.expiresAt).toBe(card!.expiresAt);
    // The Assistant's model answering another chat's card never settles it.
    expect(chatControl()!.answerApproval(session.id, card!.requestId, { approved: true }, "assistant")).toBe("stale");
    expect(chatControl()!.answerApproval(session.id, card!.requestId, { approved: true }, "telegram")).toBe("answered");
    expect(await outcome).toEqual({ allowed: true, answer: "allow_once" });
    expect(ended.find((e) => e.requestId === card!.requestId)).toMatchObject({ reason: "answered", approved: true, by: "telegram" });
  } finally {
    done();
  }
});

it("settles it from a press on the Assistant's mirror too, and says a card nobody answered expired", async () => {
  const { session, done } = await chatWaiting();
  try {
    const first = collabApprovalBroker.request(session.id, DESIGN, undefined, 60_000);
    const id = shown.at(-1)!.card.requestId;
    expect(chatControl()!.answerApproval(session.id, id, { approved: false }, "assistant_card")).toBe("answered");
    expect(await first).toMatchObject({ allowed: false, reason: "denied" });

    const late = collabApprovalBroker.request(session.id, DESIGN, undefined, 20);
    const lateId = shown.at(-1)!.card.requestId;
    expect(await late).toMatchObject({ allowed: false, reason: "timeout" });
    expect(ended.find((e) => e.requestId === lateId)).toMatchObject({ reason: "expired", approved: false });
    expect(ended.find((e) => e.requestId === lateId)).not.toHaveProperty("by");
  } finally {
    done();
  }
});

it("only names a database change to the listeners, and tells them when it ends", async () => {
  const { session, done } = await chatWaiting();
  try {
    const outcome = dbApprovalBroker.request(session.id, {
      connectionId: 7, connectionName: "Prod", dbType: "postgres", group: null, color: null, readonly: true,
      sql: "DELETE FROM jobs WHERE id = 1", reason: "Drop the stuck job",
    }, 5_000);
    expect(shown.filter((s) => s.sessionId === session.id)).toHaveLength(0);
    const [n] = named.filter((x) => x.sessionId === session.id);
    expect(n).toMatchObject({ kind: "db_execute" });
    expect(JSON.stringify(n)).not.toContain("DELETE");
    dbApprovalBroker.cancelSession(session.id, "test over");
    await outcome;
    // Given up on, not answered: a listener must not read it as the user's decision.
    expect(ended.find((e) => e.requestId === n!.requestId)).toMatchObject({ reason: "request_ended", approved: false });
  } finally {
    done();
  }
});
