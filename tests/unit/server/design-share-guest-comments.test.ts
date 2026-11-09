import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { addComment, listComments } from "../../../src/services/design/design-comments.service.ts";
import { guestCommentsIo } from "../../../src/services/design/share/design-share-comments.service.ts";
import { shareRateClock } from "../../../src/services/design/share/design-share-rate-limit.ts";
import { COMMENT_LIMITS } from "../../../src/shared/design-comment-types.ts";
import { guestHeaders, guestKey, makeShareFixture, type ShareFixture } from "./design-share-guest-fixture.ts";

const ANCHOR = { file: "index.html", ppmId: null, gen: null, tag: "h1", cssPath: "h1", quote: { exact: "Pinned", prefix: "", suffix: "" } };

describe("design share guest comments", () => {
  let f: ShareFixture;
  let now: number;
  const ann = guestKey("ann");
  const bob = guestKey("bob");

  const write = (method: string, path: string, key: string, body: unknown = {}) =>
    f.get(path, { method, headers: guestHeaders(key), body: JSON.stringify(body) });
  const post = (key: string, body: Record<string, unknown>) =>
    write("POST", "/comments", key, { anchor: ANCHOR, name: "Ann", versionId: f.link.snapshotId, ...body });
  const tick = () => { now += 600; };

  beforeEach(async () => {
    f = await makeShareFixture();
    now = 1_000_000;
    shareRateClock.now = () => now;
  });
  afterEach(() => f.restore());

  it("lists only this link's threads, marking the reviewer's own", async () => {
    await addComment(f.project, "home", { anchor: ANCHOR, body: "owner note" });
    const created = await post(ann, { body: "first" });
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(data.thread).toMatchObject({ body: "first", author: { kind: "guest", name: "Ann" }, mine: true });
    expect(JSON.stringify(data)).not.toMatch(/keyHash|snippet|linkId/);

    const mine = await (await f.get("/comments", { headers: { "X-PPM-Guest-Key": ann } })).json();
    expect(mine.data.threads.map((t: { body: string; mine: boolean }) => [t.body, t.mine])).toEqual([["first", true]]);
    const theirs = await (await f.get("/comments", { headers: { "X-PPM-Guest-Key": bob } })).json();
    expect(theirs.data.threads.map((t: { mine: boolean }) => t.mine)).toEqual([false]);
    const anonymous = await (await f.get("/comments")).json();
    expect(anonymous.data.threads).toHaveLength(1);
  });

  it("refuses another reviewer's entry, a root with replies, and threads of other links", async () => {
    const root = (await (await post(ann, { body: "root" })).json()).data.thread;
    tick();
    expect((await write("PATCH", `/comments/${root.id}`, bob, { body: "hijack" })).status).toBe(403);
    tick();
    const replied = await write("POST", `/comments/${root.id}/replies`, bob, { body: "reply", name: "Bob" });
    expect(replied.status).toBe(201);
    const reply = (await replied.json()).data.thread.replies[0];
    tick();
    expect((await write("PATCH", `/comments/${root.id}/replies/${reply.id}`, ann, { body: "x" })).status).toBe(403);
    tick();
    expect((await write("DELETE", `/comments/${root.id}/replies/${reply.id}`, ann)).status).toBe(403);
    tick();
    const deleting = await write("DELETE", `/comments/${root.id}`, ann);
    expect(deleting.status).toBe(409);
    expect(await deleting.json()).toMatchObject({ ok: false, code: "EHASREPLIES" });
    tick();
    expect((await write("PATCH", `/comments/${root.id}`, ann, { body: "edited" })).status).toBe(200);
    tick();
    expect((await write("DELETE", `/comments/${root.id}/replies/${reply.id}`, bob)).status).toBe(200);
    tick();
    // A guest may not resolve; only the body is ever passed on.
    expect((await write("PATCH", `/comments/${root.id}`, ann, { resolved: true })).status).toBe(400);

    const owner = await addComment(f.project, "home", { anchor: ANCHOR, body: "owner" });
    tick();
    expect((await write("PATCH", `/comments/${owner.id}`, ann, { body: "x" })).status).toBe(404);
    tick();
    expect((await write("POST", `/comments/${owner.id}/replies`, ann, { body: "x", name: "Ann" })).status).toBe(404);
  });

  it("requires the key, the cross-origin headers and a body within the limit", async () => {
    const noKey = await f.get("/comments", { method: "POST", headers: { "Content-Type": "application/json", "X-PPM-Request": "1" }, body: "{}" });
    expect(noKey.status).toBe(400);
    const form = await f.get("/comments", { method: "POST", headers: { "Content-Type": "text/plain", "X-PPM-Guest-Key": ann }, body: "{}" });
    expect(form.status).toBe(403);
    const big = await post(ann, { body: "x".repeat(17 * 1024) });
    expect(big.status).toBe(413);
    tick();
    expect((await post(ann, { body: "" })).status).toBe(400);
    tick();
    expect((await post(ann, { body: "hi", name: "Owner" })).status).toBe(400);
  });

  it("answers the per-link quota with 409", async () => {
    const seeded = Array.from({ length: COMMENT_LIMITS.maxGuestEntriesPerLink }, () => ({}));
    for (const _ of seeded) {
      await addComment(f.project, "home", { anchor: ANCHOR, body: "seed" }, {
        actor: { kind: "guest", linkId: f.link.id, keyHash: "a".repeat(64), name: "Seed" }, source: { snapshotId: f.link.snapshotId },
      });
    }
    const over = await post(ann, { body: "one too many" });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ code: "ETOOMANY" });
  });

  it("limits each write budget on its own, with Retry-After", async () => {
    expect((await post(ann, { body: "one" })).status).toBe(201);
    const fast = await post(ann, { body: "two" });
    expect(fast.status).toBe(429);
    expect(Number(fast.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // Spacing is per reviewer: Bob shares Ann's `local` address but is not held back by her.
    expect((await post(bob, { body: "right after" })).status).toBe(201);
    // Twenty a minute per reviewer...
    for (let i = 0; i < 19; i++) { tick(); expect((await post(ann, { body: `n${i}` })).status).toBe(201); }
    tick();
    expect((await post(ann, { body: "over" })).status).toBe(429);
    // ...and thirty per link, whoever writes.
    for (let i = 0; i < 9; i++) { tick(); expect((await post(bob, { body: `b${i}` })).status).toBe(201); }
    tick();
    expect((await post(bob, { body: "link full" })).status).toBe(429);
    // Reads have their own budget and still answer.
    expect((await f.get("/comments")).status).toBe(200);
    expect((await f.get("/f/home/hero.png")).status).toBe(200);
  });

  it("answers an unchanged poll with 304 without reading comments.json", async () => {
    await post(ann, { body: "first" });
    const first = await f.get("/comments", { headers: { "X-PPM-Guest-Key": ann } });
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const realRead = guestCommentsIo.read;
    let reads = 0;
    guestCommentsIo.read = (dir) => { reads++; return realRead(dir); };
    try {
      for (let i = 0; i < 3; i++) {
        const again = await f.get("/comments", { headers: { "X-PPM-Guest-Key": ann, "If-None-Match": etag } });
        expect(again.status).toBe(304);
        expect(again.headers.get("cache-control")).toBe("no-store");
      }
      expect(reads).toBe(0);
      // Another reviewer's view differs (`mine`), so it does not share the ETag.
      const other = await f.get("/comments", { headers: { "X-PPM-Guest-Key": bob, "If-None-Match": etag } });
      expect(other.status).toBe(200);
      // The parsed list is reused while the file is unchanged.
      expect(reads).toBe(0);
      tick();
      await post(ann, { body: "second" });
      const changed = await f.get("/comments", { headers: { "X-PPM-Guest-Key": ann, "If-None-Match": etag } });
      expect(changed.status).toBe(200);
      expect(reads).toBe(1);
      expect((await changed.json()).data.threads).toHaveLength(2);
    } finally {
      guestCommentsIo.read = realRead;
    }
    expect((await listComments(f.project, "home")).length).toBe(2);
  });

  it("never sends Access-Control-Allow-Origin: * and does not answer a preflight", async () => {
    const res = await f.get("/comments", { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await f.get("/comments", {
      method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
  });
});
