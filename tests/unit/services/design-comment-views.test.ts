import { describe, expect, it } from "bun:test";
import {
  countGuestEntries, countOwnerRoots, guestMayDeleteRoot, guestThreads, isMine, quotaRefusal, toGuestView, toOwnerView, visibleToLink,
} from "../../../src/services/design/comments/design-comment-views.ts";
import { COMMENT_LIMITS, type CommentAnchor } from "../../../src/shared/design-comment-types.ts";
import {
  parseGuestName, REMOVED_LINK_LABEL, type StoredCommentAuthor, type StoredCommentReply, type StoredDesignComment,
} from "../../../src/shared/design-comment-thread-types.ts";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const LINK_1 = "111111111111";
const LINK_2 = "222222222222";
const SNAP_1 = "20261021-120000-aaaa";
const SNAP_2 = "20261021-130000-bbbb";
const NOW = "2026-10-21T12:00:00.000Z";

const anchor: CommentAnchor = {
  file: "index.html", ppmId: 900, gen: "ffffffffffffffff", tag: "p", cssPath: "p",
  quote: { exact: "Pricing", prefix: "", suffix: "" },
};
const guest = (name: string, linkId = LINK_1, keyHash = KEY_A): StoredCommentAuthor => ({ kind: "guest", name, linkId, keyHash });
let seq = 0;
const nextId = () => (seq++).toString(16).padStart(12, "0");
const reply = (author: StoredCommentAuthor): StoredCommentReply => ({ id: nextId(), body: "re", author, createdAt: NOW, updatedAt: NOW });
const root = (over: Partial<StoredDesignComment> = {}): StoredDesignComment => ({
  id: nextId(), file: "index.html", anchor, body: "b", snippet: "<p>Pricing</p>", createdAt: NOW, updatedAt: NOW, ...over,
});
const guestRoot = (over: Partial<StoredDesignComment> = {}) => root({
  author: guest("Ann"), pinnedAnchor: { snapshotId: SNAP_1, ppmId: 42, gen: "0123456789abcdef" }, sentAt: NOW, ...over,
});

describe("parseGuestName", () => {
  it("strips control characters and line breaks, trims, and caps the length", () => {
    const rtlOverride = String.fromCodePoint(0x202e);
    expect(parseGuestName(`  Ann\nLee${String.fromCodePoint(7)}${rtlOverride} `)).toEqual({ ok: true, name: "AnnLee" });
    expect(parseGuestName("x".repeat(COMMENT_LIMITS.guestName))).toMatchObject({ ok: true });
    expect(parseGuestName("x".repeat(COMMENT_LIMITS.guestName + 1))).toMatchObject({ ok: false });
    for (const empty of ["", "  ", "\n\t", undefined, 3]) expect(parseGuestName(empty)).toMatchObject({ ok: false });
  });

  it("refuses names that read as the owner", () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    for (const name of ["Owner", " owner ", "OWNER", `Ow${zeroWidthSpace}ner`, "Ｏｗｎｅｒ", "Own\ner"]) {
      expect(parseGuestName(name)).toEqual({ ok: false, error: "That name is reserved" });
    }
    expect(parseGuestName("Owner team")).toMatchObject({ ok: true });
  });
});

describe("ownership and visibility", () => {
  it("shows a thread only to its own link, and never the owner's notes", () => {
    expect(visibleToLink(guestRoot(), LINK_1)).toBe(true);
    expect(visibleToLink(guestRoot(), LINK_2)).toBe(false);
    expect(visibleToLink(root(), LINK_1)).toBe(false);
    expect(visibleToLink(root({ author: { kind: "owner" } }), LINK_1)).toBe(false);
  });

  it("makes an entry the reviewer's only for the same link and key", () => {
    const c = guestRoot();
    expect(isMine(c, { linkId: LINK_1, keyHash: KEY_A })).toBe(true);
    expect(isMine(c, { linkId: LINK_1, keyHash: KEY_B })).toBe(false);
    expect(isMine(c, { linkId: LINK_2, keyHash: KEY_A })).toBe(false);
    expect(isMine(root(), { linkId: LINK_1, keyHash: KEY_A })).toBe(false);
  });

  it("lets a reviewer delete their root only while it has no replies", () => {
    const who = { linkId: LINK_1, keyHash: KEY_A };
    expect(guestMayDeleteRoot(guestRoot(), who)).toBe(true);
    expect(guestMayDeleteRoot(guestRoot({ replies: [reply({ kind: "owner" })] }), who)).toBe(false);
    expect(guestMayDeleteRoot(guestRoot({ replies: [reply(guest("Ann"))] }), who)).toBe(false);
    expect(guestMayDeleteRoot(guestRoot(), { linkId: LINK_1, keyHash: KEY_B })).toBe(false);
  });
});

describe("quotas", () => {
  const fill = (n: number, author: StoredCommentAuthor) => Array.from({ length: n }, () => root({ author }));

  it("counts guest roots and replies, per link and in total; owner replies count for nobody", () => {
    const list = [guestRoot({ replies: [reply(guest("Ann")), reply({ kind: "owner" })] }), root({ author: guest("Bo", LINK_2) }), root()];
    expect(countGuestEntries(list)).toBe(3);
    expect(countGuestEntries(list, LINK_1)).toBe(2);
    expect(countGuestEntries(list, LINK_2)).toBe(1);
    expect(countOwnerRoots(list)).toBe(1);
  });

  it("caps one link, then all reviewers, then the owner's own roots", () => {
    const full = fill(COMMENT_LIMITS.maxGuestEntriesPerLink, guest("Ann"));
    expect(quotaRefusal(full, guest("Ann"))).toContain(String(COMMENT_LIMITS.maxGuestEntriesPerLink));
    expect(quotaRefusal(full, guest("Bo", LINK_2))).toBeNull();
    expect(quotaRefusal(fill(COMMENT_LIMITS.maxComments, { kind: "owner" }), undefined)).toContain(String(COMMENT_LIMITS.maxComments));
    // Owner roots never use up reviewers' room, nor the other way round.
    expect(quotaRefusal(fill(COMMENT_LIMITS.maxComments, { kind: "owner" }), guest("Ann"))).toBeNull();
  });

  it("refuses the 1501st reviewer entry while every link is full, and still lets the owner write", () => {
    const links = Array.from({ length: COMMENT_LIMITS.maxGuestEntries / COMMENT_LIMITS.maxGuestEntriesPerLink }, (_, i) => i.toString(16).padStart(12, "0"));
    const all = links.flatMap((linkId) => fill(COMMENT_LIMITS.maxGuestEntriesPerLink, guest("R", linkId)));
    expect(countGuestEntries(all)).toBe(COMMENT_LIMITS.maxGuestEntries);
    expect(quotaRefusal(all, guest("New", "ffffffffffff"))).toContain(String(COMMENT_LIMITS.maxGuestEntries));
    expect(quotaRefusal(all, undefined)).toBeNull();
    expect(quotaRefusal(all, { kind: "owner" }, all[0])).toBeNull();
  });

  it("caps replies per thread for everyone", () => {
    const thread = root({ replies: Array.from({ length: COMMENT_LIMITS.maxReplies }, () => reply({ kind: "owner" })) });
    expect(quotaRefusal([thread], { kind: "owner" }, thread)).toContain(String(COMMENT_LIMITS.maxReplies));
  });
});

describe("views", () => {
  const thread = () => guestRoot({ replies: [reply(guest("Ann")), reply({ kind: "owner" }), reply(guest("Cy", LINK_1, KEY_B))] });

  it("never puts a key hash in either view", () => {
    const list = [thread(), root({ author: guest("Bo", LINK_2, KEY_B) }), root()];
    const owner = JSON.stringify(list.map((c) => toOwnerView(c, new Map([[LINK_1, "Client"]]))));
    const guestSide = JSON.stringify(guestThreads(list, { id: LINK_1, snapshotId: SNAP_1 }, KEY_A));
    for (const text of [owner, guestSide]) {
      expect(text).not.toContain(KEY_A);
      expect(text).not.toContain(KEY_B);
      expect(text).not.toContain("keyHash");
    }
  });

  it("names each guest's link for the owner, and a deleted link as removed", () => {
    const view = toOwnerView(thread(), new Map([[LINK_1, "Client"]]));
    expect(view.author).toEqual({ kind: "guest", name: "Ann", linkId: LINK_1, linkLabel: "Client" });
    expect(view.replies.map((r) => r.author.kind)).toEqual(["guest", "owner", "guest"]);
    expect(toOwnerView(thread(), new Map()).author).toMatchObject({ linkLabel: REMOVED_LINK_LABEL });
    expect(toOwnerView(root(), new Map())).toMatchObject({ author: { kind: "owner" }, replies: [], snippet: "<p>Pricing</p>" });
  });

  it("gives a reviewer names, `mine`, and no snippet, sent stamp, link or pin", () => {
    const view = toGuestView(thread(), { id: LINK_1, snapshotId: SNAP_1 }, KEY_A);
    expect(view.author).toEqual({ kind: "guest", name: "Ann" });
    expect(view.mine).toBe(true);
    expect(view.replies.map((r) => [r.author, r.mine])).toEqual([
      [{ kind: "guest", name: "Ann" }, true], [{ kind: "owner" }, false], [{ kind: "guest", name: "Cy" }, false],
    ]);
    for (const key of ["snippet", "sentAt", "pinnedAnchor"]) expect(key in view).toBe(false);
    expect(JSON.stringify(view)).not.toContain(LINK_1);
  });

  it("takes ppmId/gen from the pinned anchor only while the link shows that snapshot", () => {
    const c = guestRoot();
    expect(toGuestView(c, { id: LINK_1, snapshotId: SNAP_1 }, KEY_A).anchor).toMatchObject({ ppmId: 42, gen: "0123456789abcdef", quote: anchor.quote });
    expect(toGuestView(c, { id: LINK_1, snapshotId: SNAP_2 }, KEY_A).anchor).toMatchObject({ ppmId: null, gen: null, quote: anchor.quote });
    expect(toGuestView(guestRoot({ pinnedAnchor: undefined }), { id: LINK_1, snapshotId: SNAP_1 }, KEY_A).anchor.ppmId).toBeNull();
  });

  it("lists only the reviewer's own link's threads", () => {
    const list = [guestRoot(), root({ author: guest("Bo", LINK_2) }), root()];
    expect(guestThreads(list, { id: LINK_2, snapshotId: SNAP_1 }, KEY_A).map((t) => t.author)).toEqual([{ kind: "guest", name: "Bo" }]);
  });
});
