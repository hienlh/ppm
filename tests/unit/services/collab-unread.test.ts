import { describe, expect, it } from "bun:test";
import { createCollabUnread } from "../../../src/services/session-collab/collab-unread.ts";

const A = "session-a";
const B = "session-b";

describe("unread messages between sessions", () => {
  it("a message that opened or joined a turn is read once that turn ends", () => {
    const u = createCollabUnread({ canonical: (id) => id });
    u.add(B, A, "m1", "started");
    u.add(B, A, "m2", "inserted");
    expect(u.peek(B, A)).toBe(2);
    u.turnEnded(B); // the sender's own turn says nothing about the recipient
    expect(u.peek(B, A)).toBe(2);
    u.turnEnded(A);
    expect(u.peek(B, A)).toBe(0);
  });

  it("a queued message waits for the turn after the one running when it came", () => {
    const u = createCollabUnread({ canonical: (id) => id });
    u.add(B, A, "m1", "queued");
    u.turnEnded(A);
    expect(u.peek(B, A)).toBe(1);
    u.turnEnded(A);
    expect(u.peek(B, A)).toBe(0);
  });

  it("is read as soon as a provider names the turn it went into", () => {
    const u = createCollabUnread({ canonical: (id) => id });
    u.add(B, A, "m1", "queued");
    u.turnBound("m1");
    expect(u.peek(B, A)).toBe(0);
  });

  it("counts per direction, take forgets, and a migrated id is the same session", () => {
    const u = createCollabUnread({ canonical: (id) => (id === "old-a" ? A : id) });
    u.add(B, "old-a", "m1", "queued");
    u.add(A, B, "m2", "queued");
    expect(u.peek(B, A)).toBe(1);
    expect(u.peek(A, B)).toBe(1);
    expect(u.take(B, A)).toBe(1);
    expect(u.peek(B, A)).toBe(0);
    expect(u.peek(A, B)).toBe(1);
  });

  it("holds at most `max` messages, dropping the oldest", () => {
    const u = createCollabUnread({ canonical: (id) => id, max: 2 });
    u.add(B, A, "m1", "queued");
    u.add(B, A, "m2", "queued");
    u.add(B, A, "m3", "queued");
    expect(u.size()).toBe(2);
    u.turnBound("m1"); // already dropped: nothing happens
    expect(u.peek(B, A)).toBe(2);
  });
});
