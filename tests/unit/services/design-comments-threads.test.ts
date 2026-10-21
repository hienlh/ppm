import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { snapshotDesign } from "../../../src/services/design/design-snapshots.service.ts";
import {
  addComment, deleteComment, listComments, updateComment,
} from "../../../src/services/design/design-comments.service.ts";
import {
  addReply, deleteReply, deleteThreadsOfLink, updateReply,
} from "../../../src/services/design/design-comment-replies.service.ts";
import { onDesignEvent } from "../../../src/services/design/design-events.ts";
import { computeGen } from "../../../src/services/design/source/design-source-file.ts";
import type { CommentActor } from "../../../src/services/design/comments/design-comment-views.ts";
import { COMMENT_LIMITS, type CommentAnchor } from "../../../src/shared/design-comment-types.ts";

const V1 = "<!doctype html><html><body><main><h1>Welcome</h1><p class=lead>Pricing starts at $9 a month</p></main></body></html>";
const V2 = "<!doctype html><html><body><main><h1>Welcome back</h1><p>New intro</p><p class=lead>Pricing starts at $12 a month</p></main></body></html>";
const LINK_1 = "111111111111";
const LINK_2 = "222222222222";
const ann: CommentActor = { kind: "guest", name: "Ann", linkId: LINK_1, keyHash: "a".repeat(64) };
const cy: CommentActor = { kind: "guest", name: "Cy", linkId: LINK_1, keyHash: "c".repeat(64) };
const bo: CommentActor = { kind: "guest", name: "Bo", linkId: LINK_2, keyHash: "b".repeat(64) };

describe("design comment threads", () => {
  let project: string;
  let dir: string;
  let snapshotId: string;
  let events: number;
  let off: () => void;

  const v1Anchor = (over: Partial<CommentAnchor> = {}): CommentAnchor => ({
    file: "index.html", ppmId: V1.indexOf("<p class=lead>"), gen: computeGen(V1), tag: "p", cssPath: "",
    quote: { exact: "Pricing starts at $9 a month", prefix: "Welcome", suffix: "" }, ...over,
  });
  const asGuest = (actor: CommentActor, body = "From a reviewer") =>
    addComment(project, "home", { anchor: v1Anchor(), body }, { actor, source: { snapshotId } });
  const commentsFile = () => JSON.parse(readFileSync(join(dir, ".design", "comments.json"), "utf8"));

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-threads-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    writeFileSync(join(dir, "index.html"), V1);
    snapshotId = ((await snapshotDesign(project, "home", "manual")) as { id: string }).id;
    writeFileSync(join(dir, "index.html"), V2);
    events = 0;
    off = onDesignEvent((type) => { if (type === "comments_changed") events++; });
  });
  afterEach(() => {
    off();
    rmSync(project, { recursive: true, force: true });
  });

  it("reads a file from before threads and writes it back with the same meaning", async () => {
    const old = {
      id: "0123456789ab", file: "index.html", anchor: v1Anchor({ ppmId: null, gen: null }), body: "Old note",
      snippet: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    mkdirSync(join(dir, ".design"), { recursive: true });
    writeFileSync(join(dir, ".design", "comments.json"), JSON.stringify({ version: 1, comments: [old] }));
    expect(await listComments(project, "home")).toEqual([old]);
    await updateComment(project, "home", old.id, { resolved: true });
    const [written] = commentsFile().comments;
    expect(commentsFile().version).toBe(1);
    expect(written).toEqual({ ...old, updatedAt: written.updatedAt, resolvedAt: written.resolvedAt });
    for (const key of ["author", "replies", "pinnedAnchor"]) expect(key in written).toBe(false);
  });

  it("pins a reviewer's comment to the snapshot: snippet from the snapshot while the live file differs", async () => {
    const c = await asGuest(ann);
    expect(c.snippet).toBe("<p class=lead>Pricing starts at $9 a month</p>");
    expect(c.author).toEqual({ kind: "guest", name: "Ann", linkId: LINK_1, keyHash: "a".repeat(64) });
    expect(c.pinnedAnchor).toEqual({ snapshotId, ppmId: V1.indexOf("<p class=lead>"), gen: computeGen(V1) });
    // The same anchor against the live file has nothing to confirm it.
    const owner = await addComment(project, "home", { anchor: v1Anchor(), body: "Mine" });
    expect(owner.snippet).toBeNull();
    expect("author" in owner).toBe(false);
  });

  it("keeps no pinned ids the snapshot did not confirm, and refuses a missing snapshot or a bad name", async () => {
    const c = await addComment(project, "home", { anchor: v1Anchor({ gen: "0000000000000000" }), body: "x" }, { actor: ann, source: { snapshotId } });
    expect(c.pinnedAnchor).toEqual({ snapshotId, ppmId: null, gen: null });
    await expect(addComment(project, "home", { anchor: v1Anchor(), body: "x" }, { actor: ann, source: { snapshotId: "20200101-000000-0000" } }))
      .rejects.toMatchObject({ status: 404 });
    await expect(addComment(project, "home", { anchor: v1Anchor(), body: "x" }, { actor: ann })).rejects.toMatchObject({ status: 400 });
    await expect(addComment(project, "home", { anchor: v1Anchor(), body: "x" }, { source: { snapshotId } })).rejects.toMatchObject({ status: 400 });
    await expect(asGuest({ ...ann, name: " owner " })).rejects.toMatchObject({ status: 400, message: "That name is reserved" });
    await expect(asGuest({ ...ann, name: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("leaves pinnedAnchor alone when the owner re-anchors a reviewer's comment to the live file", async () => {
    const c = await asGuest(ann);
    const moved = await updateComment(project, "home", c.id, { anchor: { ppmId: V2.indexOf("<p class=lead>"), gen: computeGen(V2) } });
    expect(moved.anchor).toMatchObject({ ppmId: V2.indexOf("<p class=lead>"), gen: computeGen(V2) });
    expect(moved.pinnedAnchor).toEqual(c.pinnedAnchor);
    expect((await listComments(project, "home"))[0]!.pinnedAnchor).toEqual(c.pinnedAnchor);
  });

  it("lets a reviewer edit only their own text, and the owner everything but a reviewer's text", async () => {
    const c = await asGuest(ann);
    expect((await updateComment(project, "home", c.id, { body: "Edited" }, { actor: ann })).body).toBe("Edited");
    await expect(updateComment(project, "home", c.id, { body: "Hijack" }, { actor: cy })).rejects.toMatchObject({ status: 403 });
    await expect(updateComment(project, "home", c.id, { body: "x" }, { actor: bo })).rejects.toMatchObject({ status: 404 });
    await expect(updateComment(project, "home", c.id, { resolved: true }, { actor: ann })).rejects.toMatchObject({ status: 403 });
    await expect(updateComment(project, "home", c.id, { body: "Owner rewrite" })).rejects.toMatchObject({ status: 403 });
    expect((await updateComment(project, "home", c.id, { resolved: true })).resolvedAt).toBeTruthy();
    const ownerNote = await addComment(project, "home", { anchor: v1Anchor(), body: "Private" });
    await expect(updateComment(project, "home", ownerNote.id, { body: "x" }, { actor: ann })).rejects.toMatchObject({ status: 404 });
  });

  it("threads replies: reviewers on the same link and the owner, each changing only their own", async () => {
    const c = await asGuest(ann);
    const r1 = await addReply(project, "home", c.id, { body: "Agree" }, { actor: cy });
    const r2 = await addReply(project, "home", c.id, { body: " Will fix " });
    expect(r2.thread.replies!.map((r) => [r.author.kind, r.body])).toEqual([["guest", "Agree"], ["owner", "Will fix"]]);
    await expect(addReply(project, "home", c.id, { body: "x" }, { actor: bo })).rejects.toMatchObject({ status: 404 });

    expect((await updateReply(project, "home", c.id, r1.reply.id, { body: "Agree!" }, { actor: cy })).reply.body).toBe("Agree!");
    await expect(updateReply(project, "home", c.id, r1.reply.id, { body: "x" }, { actor: ann })).rejects.toMatchObject({ status: 403 });
    await expect(updateReply(project, "home", c.id, r1.reply.id, { body: "x" })).rejects.toMatchObject({ status: 403 });
    expect((await updateReply(project, "home", c.id, r2.reply.id, { body: "Fixed" })).reply.body).toBe("Fixed");
    await expect(updateReply(project, "home", c.id, r2.reply.id, { body: "x" }, { actor: cy })).rejects.toMatchObject({ status: 403 });

    await expect(deleteReply(project, "home", c.id, r2.reply.id, { actor: cy })).rejects.toMatchObject({ status: 403 });
    expect((await deleteReply(project, "home", c.id, r1.reply.id, { actor: cy })).replies!.map((r) => r.id)).toEqual([r2.reply.id]);
    const emptied = await deleteReply(project, "home", c.id, r2.reply.id);
    expect("replies" in emptied).toBe(false);
    await expect(deleteReply(project, "home", c.id, r2.reply.id)).rejects.toMatchObject({ status: 404 });
    await expect(addReply(project, "home", c.id, { body: "" })).rejects.toMatchObject({ status: 400 });
    await expect(addReply(project, "home", "abcdefabcdef", { body: "x" })).rejects.toMatchObject({ status: 404 });
    expect(events).toBe(7);
  });

  it("keeps a reviewer from deleting a root others replied to, while the owner still can", async () => {
    const c = await asGuest(ann);
    await addReply(project, "home", c.id, { body: "Noted" });
    await expect(deleteComment(project, "home", c.id, { actor: ann })).rejects.toMatchObject({ status: 409 });
    await expect(deleteComment(project, "home", c.id, { actor: cy })).rejects.toMatchObject({ status: 403 });
    await deleteComment(project, "home", c.id);
    expect(await listComments(project, "home")).toEqual([]);

    const lone = await asGuest(ann);
    await deleteComment(project, "home", lone.id, { actor: ann });
    expect(await listComments(project, "home")).toEqual([]);
  });

  it("caps replies per thread", async () => {
    const c = await asGuest(ann);
    const now = new Date().toISOString();
    const file = commentsFile();
    file.comments[0].replies = Array.from({ length: COMMENT_LIMITS.maxReplies }, (_, i) => ({
      id: i.toString(16).padStart(12, "0"), body: "r", author: { kind: "owner" }, createdAt: now, updatedAt: now,
    }));
    writeFileSync(join(dir, ".design", "comments.json"), JSON.stringify(file));
    await expect(addReply(project, "home", c.id, { body: "one more" })).rejects.toMatchObject({ status: 409, code: "ETOOMANY" });
  });

  it("still lets the owner comment with every link at its cap and all reviewers at theirs", async () => {
    const now = new Date().toISOString();
    const links = COMMENT_LIMITS.maxGuestEntries / COMMENT_LIMITS.maxGuestEntriesPerLink;
    const comments = Array.from({ length: COMMENT_LIMITS.maxGuestEntries }, (_, i) => ({
      id: i.toString(16).padStart(12, "0"), file: "index.html", anchor: v1Anchor(), body: "g", snippet: null, createdAt: now, updatedAt: now,
      author: { kind: "guest", name: "R", linkId: (i % links).toString(16).padStart(12, "0"), keyHash: "d".repeat(64) },
    }));
    mkdirSync(join(dir, ".design"), { recursive: true });
    writeFileSync(join(dir, ".design", "comments.json"), JSON.stringify({ version: 1, comments }));
    const fullLink: CommentActor = { kind: "guest", name: "R", linkId: "000000000000", keyHash: "d".repeat(64) };
    await expect(asGuest(fullLink)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(String(COMMENT_LIMITS.maxGuestEntriesPerLink)) });
    await expect(asGuest(ann)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(String(COMMENT_LIMITS.maxGuestEntries)) });
    await expect(addReply(project, "home", comments[0]!.id, { body: "x" }, { actor: fullLink })).rejects.toMatchObject({ status: 409 });
    const owner = await addComment(project, "home", { anchor: v1Anchor(), body: "Still mine" });
    expect(owner.body).toBe("Still mine");
    expect((await addReply(project, "home", comments[0]!.id, { body: "Owner reply" })).reply.author).toEqual({ kind: "owner" });
    expect(await listComments(project, "home")).toHaveLength(COMMENT_LIMITS.maxGuestEntries + 1);
  });

  it("bulk-deletes one link's threads only", async () => {
    const a = await asGuest(ann);
    await addReply(project, "home", a.id, { body: "re" }, { actor: cy });
    await asGuest(cy);
    const b = await asGuest(bo);
    const own = await addComment(project, "home", { anchor: v1Anchor(), body: "Mine" });
    events = 0;
    expect(await deleteThreadsOfLink(project, "home", LINK_1)).toBe(2);
    expect((await listComments(project, "home")).map((c) => c.id).sort()).toEqual([b.id, own.id].sort());
    expect(events).toBe(1);
    expect(await deleteThreadsOfLink(project, "home", LINK_1)).toBe(0);
    expect(events).toBe(1);
    await expect(deleteThreadsOfLink(project, "home", "../x")).rejects.toMatchObject({ status: 404 });
  });

  it("drops a stored entry whose author is malformed rather than reading it as the owner's", async () => {
    const now = new Date().toISOString();
    const base = { file: "index.html", anchor: v1Anchor(), body: "b", snippet: null, createdAt: now, updatedAt: now };
    mkdirSync(join(dir, ".design"), { recursive: true });
    writeFileSync(join(dir, ".design", "comments.json"), JSON.stringify({ version: 1, comments: [
      { ...base, id: "000000000001", author: { kind: "guest", name: "Owner", linkId: LINK_1, keyHash: "a".repeat(64) } },
      { ...base, id: "000000000002", author: { kind: "guest", name: "Ann", linkId: LINK_1 } },
      { ...base, id: "000000000003", author: { kind: "admin" } },
      { ...base, id: "000000000004", author: { kind: "owner" }, replies: [{ id: "bad" }, { id: "000000000005", body: "ok", createdAt: now }] },
    ] }));
    const list = await listComments(project, "home");
    expect(list.map((c) => c.id)).toEqual(["000000000004"]);
    expect(list[0]!.replies).toEqual([{ id: "000000000005", body: "ok", author: { kind: "owner" }, createdAt: now, updatedAt: now }]);
  });
});
