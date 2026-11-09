import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { listComments } from "../../../src/services/design/design-comments.service.ts";
import { withRecoveredDesign } from "../../../src/services/design/design-restore-journal.ts";
import { snapshotDesign } from "../../../src/services/design/design-snapshots.service.ts";
import { updateShareLink } from "../../../src/services/design/share/design-share-links.service.ts";
import { shareRateClock } from "../../../src/services/design/share/design-share-rate-limit.ts";
import { GUEST_VERSION_CHANGED } from "../../../src/shared/design-share-guest-types.ts";
import { guestHeaders, guestKey, makeShareFixture, type ShareFixture } from "./design-share-guest-fixture.ts";

/**
 * A reviewer's write can wait on the design lock behind a snapshot or a restore. Whatever
 * happened to the link meanwhile is checked again once the lock is held: a revoke, a new
 * code, an expiry or sign-in turned off refuses the write and tells the owner nothing, and a
 * re-pin refuses a new comment made on the version the reviewer's page still shows.
 */

const ANCHOR = { file: "index.html", ppmId: null, gen: null, tag: "h1", cssPath: "", quote: { exact: "Pinned", prefix: "", suffix: "" } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("design share guest writes re-checked under the design lock", () => {
  let f: ShareFixture;
  let now: number;
  const ann = guestKey("ann");

  const write = (path: string, body: Record<string, unknown>) =>
    f.get(path, { method: "POST", headers: guestHeaders(ann), body: JSON.stringify(body) });
  const comment = (body: Record<string, unknown> = {}) =>
    write("/comments", { anchor: ANCHOR, name: "Ann", body: "hello", versionId: f.link.snapshotId, ...body });
  const guestRoots = async () => (await listComments(f.project, "home")).filter((c) => c.author?.kind === "guest");

  /** Runs `meanwhile` while `request` waits for the design lock, then lets it through. */
  async function whileQueued(request: () => Promise<Response>, meanwhile: () => Promise<void> | void): Promise<Response> {
    let release!: () => void;
    const held = withRecoveredDesign(f.project, "home", () => new Promise<void>((r) => { release = r; }));
    await sleep(20);
    const pending = request();
    await sleep(150);
    await meanwhile();
    release();
    await held;
    return pending;
  }

  beforeEach(async () => {
    f = await makeShareFixture();
    now = 1_000_000;
    shareRateClock.now = () => now;
  });
  afterEach(() => f.restore());

  const closers: Array<[string, () => Promise<void> | void]> = [
    ["a revoke", async () => { await updateShareLink(f.project, "home", f.link.id, { revoke: true }); }],
    ["a new code", async () => { await updateShareLink(f.project, "home", f.link.id, { newCode: true }); }],
    ["an expiry", () => { getDb().query("UPDATE design_share_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1, f.link.id); }],
    ["sign-in turned off", () => { configService.set("auth", { ...configService.get("auth"), enabled: false }); }],
  ];

  for (const [what, close] of closers) {
    it(`refuses a comment and a reply queued behind the lock when ${what} lands meanwhile`, async () => {
      const root = (await (await comment()).json()).data.thread;
      now += 1_000;
      f.notes.length = 0;
      const refusedRoot = await whileQueued(() => comment({ body: "late" }), close);
      expect(refusedRoot.status).toBe(404);
      expect(await refusedRoot.json()).toEqual({ ok: false, error: expect.any(String) });
      now += 1_000;
      // The link is closed for good now, so the reply is refused before the lock as well.
      const refusedReply = await write(`/comments/${root.id}/replies`, { body: "late reply", name: "Ann" });
      expect(refusedReply.status).toBe(404);
      expect((await guestRoots()).map((c) => [c.body, c.replies?.length ?? 0])).toEqual([["hello", 0]]);
      expect(f.notes).toEqual([]);
    });
  }

  it("refuses a reply queued behind the lock when the link is revoked meanwhile", async () => {
    const root = (await (await comment()).json()).data.thread;
    now += 1_000;
    f.notes.length = 0;
    const refused = await whileQueued(
      () => write(`/comments/${root.id}/replies`, { body: "late reply", name: "Ann" }),
      async () => { await updateShareLink(f.project, "home", f.link.id, { revoke: true }); },
    );
    expect(refused.status).toBe(404);
    expect((await guestRoots())[0]?.replies).toBeUndefined();
    expect(f.notes).toEqual([]);
  });

  it("refuses a new comment made on the version a re-pin replaced while it waited", async () => {
    writeFileSync(join(f.designs, "home", "index.html"), "<h1>Newer</h1>");
    const taken = await snapshotDesign(f.project, "home", "manual");
    if (!("id" in taken)) throw new Error("expected a new snapshot");
    // A re-pin's own snapshot takes the design lock, so its commit is the part that can land
    // while a comment waits: the row moving to the new snapshot.
    const refused = await whileQueued(() => comment(), () => {
      getDb().query("UPDATE design_share_links SET snapshot_id = ? WHERE id = ?").run(taken.id, f.link.id);
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, code: GUEST_VERSION_CHANGED });
    expect(await guestRoots()).toEqual([]);
    expect(f.notes).toEqual([]);
  });

  it("refuses a comment that names no version or an old one, and tells the page which one is shown", async () => {
    const info = (await (await f.get("/info")).json()).data;
    expect(info.versionId).toBe(f.link.snapshotId);
    const listed = await f.get("/comments");
    expect((await listed.json()).data.versionId).toBe(f.link.snapshotId);

    for (const versionId of [undefined, "not-a-snapshot", "20260101-000000-abcd"]) {
      now += 1_000;
      const res = await comment({ versionId });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: GUEST_VERSION_CHANGED });
    }
    writeFileSync(join(f.designs, "home", "index.html"), "<h1>Newer</h1>");
    const { link } = await updateShareLink(f.project, "home", f.link.id, { repin: true });
    const after = await f.get("/comments", { headers: { "If-None-Match": listed.headers.get("etag")! } });
    expect(after.status).toBe(200);
    expect((await after.json()).data.versionId).toBe(link.snapshotId);
    now += 1_000;
    expect((await comment()).status).toBe(409);
    now += 1_000;
    expect((await comment({ versionId: link.snapshotId })).status).toBe(201);
    expect(f.notes).toHaveLength(1);
  });
});
