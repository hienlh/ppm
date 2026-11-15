/**
 * A vault card in a real chat: it takes the session's approval slot like any PPM approval, and
 * only the HTTP route with the tier's password answers it. A browser's `approval_response`, a
 * Telegram button and the Assistant answering it on the user's behalf all leave it waiting.
 */
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { chatService } from "../../../src/services/chat.service.ts";
import { chatWebSocket } from "../../../src/server/ws/chat.ts";
import { chatControl } from "../../../src/services/chat-control/chat-control.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { vaultService } from "../../../src/services/vault/vault.service.ts";
import { vaultUnlockBroker } from "../../../src/services/vault/vault-unlock-broker.ts";
import { vaultRoutes } from "../../../src/server/routes/vault.ts";
import { vaultGrants } from "../../../src/services/vault/vault-grants.ts";

const MK2 = "secure-pass-0001";
const app = new Hono().route("/api/vault", vaultRoutes);
const post = (path: string, body: unknown) => app.request(`/api/vault${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => { getDb().exec("DELETE FROM vault_items; DELETE FROM vault_keys;"); vaultGrants.lock(); });
afterEach(() => vaultGrants.lock());

it("is answered only over HTTP with the tier's password", async () => {
  await vaultService.enableTier("secure", MK2);
  const u = await vaultService.unlock("secure", MK2);
  if (!u.ok) throw new Error("unlock");
  const item = vaultService.addItem({ tier: "secure", name: "NI", kind: "ni_number", value: "CANARY-T2-ws" }, u.dek);
  u.dek.fill(0);

  const session = await chatService.createSession("mock", {});
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const send = spyOn(chatService, "sendMessage").mockImplementation(async function* () {
    yield { type: "text", content: "working" } as any;
    await gate;
  });
  const messages: any[] = [];
  const socket = { data: { sessionId: session.id }, send: (json: string) => messages.push(JSON.parse(json)) };
  chatWebSocket.open(socket as any);
  try {
    await chatWebSocket.message(socket as any, JSON.stringify({ type: "message", content: "read my NI" }));
    for (let i = 0; i < 100 && !messages.some((m) => m.type === "text"); i++) await Bun.sleep(5);

    const outcome = vaultUnlockBroker.requestSecure(session.id, [item.id], "fill a form", { origin: "ws", sessionTitle: null, assistant: false });
    const card = messages.find((m) => m.type === "approval_request" && m.tool === "ppm:vault");
    expect(card).toBeTruthy();
    expect(JSON.stringify(messages)).not.toContain("CANARY");

    await chatWebSocket.message(socket as any, JSON.stringify({ type: "approval_response", requestId: card.requestId, approved: true }));
    expect(vaultUnlockBroker.has(card.requestId)).toBe(true);
    expect(chatControl()!.answerApproval(session.id, card.requestId, { approved: true }, "telegram")).toBe("stale");
    expect(chatControl()!.answerApproval(session.id, card.requestId, { approved: true }, "assistant")).toBe("stale");
    expect(vaultUnlockBroker.has(card.requestId)).toBe(true);
    // Server-side readers (Telegram /status, watches, chats_attention) never get the card itself.
    expect(chatControl()!.liveState(session.id)?.card).toBeUndefined();

    const wrong = await post(`/cards/${card.requestId}`, { approved: true, password: "not-the-password", itemIds: [item.id] });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { attemptsLeft: number }).attemptsLeft).toBe(4);

    const right = await post(`/cards/${card.requestId}`, { approved: true, password: MK2, itemIds: [item.id] });
    expect(right.status).toBe(200);
    const r = await outcome;
    expect(r.ok && "items" in r && r.items[0]!.value).toBe("CANARY-T2-ws");
    expect(messages.some((m) => m.type === "approval_resolved" && m.requestId === card.requestId)).toBe(true);
  } finally {
    vaultUnlockBroker.cancelSession(session.id, "test over");
    release();
    send.mockRestore();
    chatWebSocket.close(socket as any);
  }
});

const PAGE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_PAGE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

it("Settings keeps the secure tier open five minutes for the page that unlocked it only; the sealed tier asks every time; lock ends it", async () => {
  expect((await post("/tiers/secure/enable", { password: MK2 })).status).toBe(200);
  expect((await post("/tiers/sealed/enable", { password: "sealed-password-0001" })).status).toBe(200);
  expect((await post("/items", { tier: "secure", name: "NI", kind: "ni_number", value: "v", handle: PAGE })).status).toBe(423);
  expect((await post("/tiers/secure/unlock", { password: MK2 })).status).toBe(400);
  expect((await post("/tiers/secure/unlock", { password: MK2, handle: PAGE })).status).toBe(200);
  const added = await post("/items", { tier: "secure", name: "NI", kind: "ni_number", value: "CANARY-T2-settings", handle: PAGE });
  expect(added.status).toBe(200);
  const id = ((await added.json()) as { data: { id: string } }).data.id;
  const shown = (await (await post(`/items/${id}/reveal`, { handle: PAGE })).json()) as { data: { value: string } };
  expect(shown.data.value).toBe("CANARY-T2-settings");
  // The auth token alone (no handle, or another page's) never reaches the open tier.
  expect((await post(`/items/${id}/reveal`, {})).status).toBe(423);
  expect((await post(`/items/${id}/reveal`, { handle: OTHER_PAGE })).status).toBe(423);
  // Taking an item out to the public tier asks for the password even while the tier is open.
  expect((await post(`/items/${id}/move`, { to: "public", handle: PAGE })).status).toBe(423);
  expect((await post("/tiers/sealed/unlock", { password: "sealed-password-0001" })).status).toBe(400);
  expect((await post("/items", { tier: "sealed", name: "P", kind: "passport", value: "v" })).status).toBe(423);
  expect((await post("/items", { tier: "sealed", name: "P", kind: "passport", value: "v", password: "sealed-password-0001" })).status).toBe(200);
  expect((await post("/lock", {})).status).toBe(200);
  expect((await post(`/items/${id}/reveal`, { handle: PAGE })).status).toBe(423);
  const status = (await (await app.request("/api/vault/status")).json()) as { data: { tiers: { secure: { itemCount: number; settingsOpenUntil: number } } } };
  expect(status.data.tiers.secure).toMatchObject({ itemCount: 1, settingsOpenUntil: 0 });
  const listed = await (await app.request("/api/vault/items")).text();
  expect(listed).not.toContain("CANARY");
});
