import { describe, expect, it } from "bun:test";
import { connectChat, disconnectChat, freshChat } from "./bridge-test-kit.ts";
import { canSendTo, checkAccess, reachableChats, refusalText } from "../../../../src/services/assistant-telegram/assistant-telegram-access.ts";
import { upsertApprovedPairing } from "../../../../src/services/db.service.ts";

const priv = (id: number) => ({ id, type: "private" as const });

describe("who may use the Assistant on Telegram", () => {
  it("lets in the person who connected a private chat", () => {
    const id = freshChat();
    connectChat(id);
    expect(checkAccess(priv(id), { id })).toEqual({ ok: true });
    expect(canSendTo(String(id))).toBe(true);
  });

  it("refuses a group, whoever writes in it", () => {
    const id = -freshChat();
    upsertApprovedPairing(String(id), "42", "A group");
    expect(checkAccess({ id, type: "group" }, { id: 42 })).toEqual({ ok: false, refusal: "not-private" });
    expect(checkAccess({ id, type: "supergroup" }, { id: 42 })).toEqual({ ok: false, refusal: "not-private" });
    // Nor is anything sent there: a private chat's id is its user's.
    expect(canSendTo(String(id))).toBe(false);
  });

  it("refuses someone else writing in a connected chat, and a chat nobody connected", () => {
    const id = freshChat();
    connectChat(id);
    expect(checkAccess(priv(id), { id: id + 1 })).toEqual({ ok: false, refusal: "wrong-user" });
    expect(checkAccess(priv(id), undefined)).toEqual({ ok: false, refusal: "wrong-user" });
    expect(checkAccess(priv(freshChat()), { id: 1 })).toEqual({ ok: false, refusal: "not-connected" });
  });

  it("asks a chat connected without a user id to connect again, and never matches the empty id", () => {
    const id = freshChat();
    upsertApprovedPairing(String(id), "", "Old pairing");
    expect(checkAccess(priv(id), { id })).toEqual({ ok: false, refusal: "reconnect" });
    expect(canSendTo(String(id))).toBe(false);
    expect(reachableChats().some((c) => c.chatId === String(id))).toBe(false);
    expect(refusalText("reconnect")).toContain("reconnect");
  });

  it("stops sending to a chat the moment it is revoked", () => {
    const id = freshChat();
    connectChat(id);
    expect(reachableChats().some((c) => c.chatId === String(id))).toBe(true);
    disconnectChat(id);
    expect(canSendTo(String(id))).toBe(false);
    expect(checkAccess(priv(id), { id })).toEqual({ ok: false, refusal: "not-connected" });
  });
});
