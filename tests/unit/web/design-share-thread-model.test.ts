import { describe, expect, it } from "bun:test";
import {
  asPinComments, bylineOf, groupThreads, pinNumbers, pinStatusText, removeThread, rootDelete, upsertThread, type GuestThread,
} from "../../../src/web/design-share-page/share-thread-model";

const anchor = { file: "index.html", ppmId: 3, gen: null, tag: "h1", cssPath: "h1", quote: { exact: "Hi", prefix: "", suffix: "" } };

function thread(id: string, over: Partial<GuestThread> = {}): GuestThread {
  return {
    id, file: "index.html", anchor, body: `body ${id}`, createdAt: `2026-10-21T10:00:0${id.slice(-1)}.000Z`,
    updatedAt: `2026-10-21T10:00:0${id.slice(-1)}.000Z`, author: { kind: "guest", name: "Mai" }, mine: false, replies: [],
    ...over,
  };
}

const reply = (id: string, mine: boolean) => ({
  id, body: "r", author: { kind: "guest" as const, name: "Lan" }, createdAt: "2026-10-21T11:00:00.000Z",
  updatedAt: "2026-10-21T11:00:00.000Z", mine,
});

describe("design share threads", () => {
  it("numbers open threads in creation order and folds resolved ones apart", () => {
    const list = [
      thread("aaaaaaaaaaa3"), thread("aaaaaaaaaaa1"),
      thread("aaaaaaaaaaa2", { resolvedAt: "2026-10-21T12:00:00.000Z" }),
      thread("aaaaaaaaaaa4", { resolvedAt: "2026-10-21T13:00:00.000Z" }),
    ];
    const { open, resolved } = groupThreads(list);
    expect(open.map((t) => t.id)).toEqual(["aaaaaaaaaaa1", "aaaaaaaaaaa3"]);
    expect(resolved.map((t) => t.id)).toEqual(["aaaaaaaaaaa4", "aaaaaaaaaaa2"]);
    expect([...pinNumbers(open)]).toEqual([["aaaaaaaaaaa1", 1], ["aaaaaaaaaaa3", 2]]);
  });

  it("lets the author delete their thread only while nobody has replied", () => {
    expect(rootDelete(thread("aaaaaaaaaaa1"))).toBeNull();
    expect(rootDelete(thread("aaaaaaaaaaa1", { mine: true }))).toEqual({ allowed: true });
    const answered = rootDelete(thread("aaaaaaaaaaa1", { mine: true, replies: [reply("bbbbbbbbbbb1", false)] }));
    expect(answered).toEqual({ allowed: false, reason: "Others replied, so you can edit it but not delete it." });
    const ownReplies = rootDelete(thread("aaaaaaaaaaa1", { mine: true, replies: [reply("bbbbbbbbbbb1", true)] }));
    expect(ownReplies).toEqual({ allowed: false, reason: "It has replies, so you can edit it but not delete it." });
  });

  it("shows the owner as a badge, never as a name a reviewer could type", () => {
    expect(bylineOf({ kind: "owner" })).toEqual({ owner: true });
    expect(bylineOf({ kind: "guest", name: "Owner" })).toEqual({ owner: false, name: "Owner" });
  });

  it("folds a write's answer into the list", () => {
    const list = [thread("aaaaaaaaaaa1"), thread("aaaaaaaaaaa2")];
    const edited = thread("aaaaaaaaaaa2", { body: "changed" });
    expect(upsertThread(list, edited).map((t) => t.body)).toEqual(["body aaaaaaaaaaa1", "changed"]);
    expect(upsertThread(list, thread("aaaaaaaaaaa3"))).toHaveLength(3);
    expect(removeThread(list, "aaaaaaaaaaa1").map((t) => t.id)).toEqual(["aaaaaaaaaaa2"]);
  });

  it("hands the pin hook the anchors and nothing a reviewer view lacks", () => {
    const [pin] = asPinComments([thread("aaaaaaaaaaa1")]);
    expect(pin).toEqual({
      id: "aaaaaaaaaaa1", file: "index.html", anchor, body: "body aaaaaaaaaaa1", snippet: null,
      createdAt: "2026-10-21T10:00:01.000Z", updatedAt: "2026-10-21T10:00:01.000Z",
    });
  });

  it("describes a pin in the owner canvas's words", () => {
    expect(pinStatusText("pinned", 2, false)).toBe("Pin 2");
    expect(pinStatusText("detached", 2, false)).toBe("Detached");
    expect(pinStatusText("elsewhere", 1, false)).toBe("On another page");
    expect(pinStatusText("pinned", null, true)).toBe("Resolved");
  });
});
