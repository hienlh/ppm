/**
 * Unlinking hides a session from one chat's list and nothing else: only a finished session can be
 * hidden, a hidden one that messages the chat again comes back, and the synced record stays bounded
 * and is checked before the server stores it.
 */
import { describe, expect, it } from "bun:test";
import {
  MAX_UNLINK_CHATS, MAX_UNLINKS_PER_CHAT, canUnlink, isUnlinkMap, lastMessageFrom, splitUnlinked, updateUnlinks,
} from "../../../src/shared/linked-session-unlinks";
import { encodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import type { ChatMessage } from "../../../src/types/chat";

const A = "aaaaaaaa-1111-4000-8000-00000000000a";
const B = "bbbbbbbb-2222-4000-8000-00000000000b";
const from = (sessionId: string, sentAt: string): ChatMessage => ({
  id: `${sessionId}-${sentAt}`, role: "user", timestamp: sentAt,
  content: encodeMessageBlocks("hi", { fromSession: { version: 1, sessionId, providerId: "claude", projectName: "p", title: "T", sentAt } }),
});

describe("canUnlink", () => {
  it("lets an idle or finished session go, never one still working or waiting on the person", () => {
    expect(canUnlink("idle")).toBe(true);
    expect(canUnlink("new_message")).toBe(true);
    expect(canUnlink("running")).toBe(false);
    expect(canUnlink("needs_approval")).toBe(false);
  });
});

describe("lastMessageFrom", () => {
  it("keeps the latest message each session sent, ignoring the chat's own messages", () => {
    const last = lastMessageFrom([
      from(A, "2026-11-01T00:00:00.000Z"),
      from(A, "2026-11-03T00:00:00.000Z"),
      from(B, "2026-11-02T00:00:00.000Z"),
      { id: "own", role: "user", timestamp: "2026-11-09T00:00:00.000Z", content: "plain" },
    ]);
    expect(last.get(A)).toBe(Date.parse("2026-11-03T00:00:00.000Z"));
    expect(last.get(B)).toBe(Date.parse("2026-11-02T00:00:00.000Z"));
    expect(last.size).toBe(2);
  });
});

describe("splitUnlinked", () => {
  const linked = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];
  const at = Date.parse("2026-11-05T00:00:00.000Z");

  it("hides what was unlinked and shows the rest in their order", () => {
    const { visible, hidden } = splitUnlinked(linked, { b: at }, new Map());
    expect(visible.map((l) => l.sessionId)).toEqual(["a", "c"]);
    expect(hidden.map((l) => l.sessionId)).toEqual(["b"]);
  });

  it("shows a hidden session again once it messages the chat after the unlink, but not for an older message", () => {
    expect(splitUnlinked(linked, { b: at }, new Map([["b", at - 1]])).hidden.map((l) => l.sessionId)).toEqual(["b"]);
    expect(splitUnlinked(linked, { b: at }, new Map([["b", at + 1]])).hidden).toEqual([]);
  });

  it("shows a hidden session again while it runs or waits on the person", () => {
    const withStatus = (status: string) => [{ sessionId: "b", status }];
    expect(splitUnlinked(withStatus("idle"), { b: at }, new Map()).hidden).toHaveLength(1);
    expect(splitUnlinked(withStatus("new_message"), { b: at }, new Map()).hidden).toHaveLength(1);
    expect(splitUnlinked(withStatus("running"), { b: at }, new Map()).visible).toHaveLength(1);
    expect(splitUnlinked(withStatus("needs_approval"), { b: at }, new Map()).visible).toHaveLength(1);
  });
});

describe("updateUnlinks", () => {
  it("records each hide against that session's own last message, never the device clock", () => {
    const last = new Map([["a", 500]]);
    const map = updateUnlinks({}, "chat", ["a", "b"], true, (id) => last.get(id) ?? 0);
    expect(map).toEqual({ chat: { a: 500, b: 0 } });
    // A session that never messaged comes back with its first message; one that did, with a newer one.
    expect(splitUnlinked([{ sessionId: "b" }], map.chat, new Map([["b", 1]])).visible).toHaveLength(1);
    expect(splitUnlinked([{ sessionId: "a" }], map.chat, new Map([["a", 500]])).hidden).toHaveLength(1);
  });

  it("adds and removes per chat, dropping a chat with nothing left", () => {
    const one = updateUnlinks({}, "chat", ["a", "b"], true, 10);
    expect(one).toEqual({ chat: { a: 10, b: 10 } });
    expect(updateUnlinks(one, "chat", ["a"], false)).toEqual({ chat: { b: 10 } });
    expect(updateUnlinks(one, "chat", ["a", "b"], false)).toEqual({});
  });

  it("keeps the newest unlinks per chat and the most recently touched chats", () => {
    let map = {};
    for (let i = 0; i < MAX_UNLINKS_PER_CHAT + 5; i++) map = updateUnlinks(map, "chat", [`s${i}`], true, i);
    expect(Object.keys((map as Record<string, object>).chat!)).toHaveLength(MAX_UNLINKS_PER_CHAT);
    expect((map as Record<string, Record<string, number>>).chat!.s0).toBeUndefined();

    let chats = {};
    for (let i = 0; i < MAX_UNLINK_CHATS + 3; i++) chats = updateUnlinks(chats, `c${i}`, ["x"], true, i);
    expect(Object.keys(chats)).toHaveLength(MAX_UNLINK_CHATS);
    expect((chats as Record<string, unknown>).c0).toBeUndefined();
    expect((chats as Record<string, unknown>)[`c${MAX_UNLINK_CHATS + 2}`]).toBeDefined();
  });
});

describe("isUnlinkMap", () => {
  it("accepts the record's shape and refuses anything else the server could be sent", () => {
    expect(isUnlinkMap({})).toBe(true);
    expect(isUnlinkMap({ chat: { a: 1 } })).toBe(true);
    expect(isUnlinkMap(null)).toBe(false);
    expect(isUnlinkMap([])).toBe(false);
    expect(isUnlinkMap({ chat: ["a"] })).toBe(false);
    expect(isUnlinkMap({ chat: { a: "1" } })).toBe(false);
    expect(isUnlinkMap({ chat: { a: Number.NaN } })).toBe(false);
  });
});
