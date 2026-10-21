import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateShareLink } from "../../../src/services/design/share/design-share-links.service.ts";
import { getShareLink } from "../../../src/services/design/share/design-share-links-store.ts";
import { makeShareFixture, type ShareFixture } from "./design-share-guest-fixture.ts";

/**
 * "Update to latest" awaits a whole design snapshot before it saves, so other changes to the
 * same link (from another tab or device) commit while it runs. Those changes must survive it,
 * and a revoke landing in that window must win.
 */

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  return null;
}

describe("design share re-pin racing other link changes", () => {
  let f: ShareFixture;
  beforeEach(async () => {
    f = await makeShareFixture();
    // A live change, so the re-pin takes a real snapshot and awaits it before saving.
    writeFileSync(join(f.designs, "home", "index.html"), "<p>changed</p>".repeat(2000));
  });
  afterEach(() => f.restore());

  it("keeps a revoke and a new code issued while the re-pin runs, and refuses the re-pin", async () => {
    const repin = refusal(updateShareLink(f.project, "home", f.link.id, { repin: true }));
    await updateShareLink(f.project, "home", f.link.id, { newCode: true });
    const afterNewCode = getShareLink(f.link.id)!;
    await updateShareLink(f.project, "home", f.link.id, { revoke: true });
    expect(await repin).toMatchObject({ status: 409, code: "revoked" });

    const row = getShareLink(f.link.id)!;
    expect(row.revokedAt).not.toBeNull();
    expect(row.codeVersion).toBe(afterNewCode.codeVersion);
    expect(row.codeHash).toBe(afterNewCode.codeHash);
    expect(row.snapshotId).toBe(f.link.snapshotId);
    expect((await f.get("/info")).status).toBe(404);
  });

  it("keeps a new code, label and expiry set while the re-pin runs, and still re-pins", async () => {
    const expiresAt = Date.now() + 3_600_000;
    const repin = updateShareLink(f.project, "home", f.link.id, { repin: true });
    const { link: rotated } = await updateShareLink(f.project, "home", f.link.id, { newCode: true });
    await updateShareLink(f.project, "home", f.link.id, { label: "Renamed", expiresAt });
    const { link } = await repin;

    expect(link.snapshotId).not.toBe(f.link.snapshotId);
    expect(link.path).toBe(rotated.path);
    expect(link.label).toBe("Renamed");
    expect(link.expiresAt).toBe(expiresAt);
    expect((await f.get("/info")).status).toBe(404);
    const fresh = await f.app.request(`http://localhost${rotated.path}/info`);
    expect(fresh.status).toBe(200);
  });

  it("never clears a revoke, whatever a later change carries", async () => {
    await updateShareLink(f.project, "home", f.link.id, { revoke: true });
    const revokedAt = getShareLink(f.link.id)!.revokedAt;
    await updateShareLink(f.project, "home", f.link.id, { revoke: true, label: "again" });
    expect(getShareLink(f.link.id)!.revokedAt).toBe(revokedAt);
  });
});
