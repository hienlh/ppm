import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../../../src/services/db.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { createDesign } from "../../../src/services/design/design-store.service.ts";
import { snapshotDir } from "../../../src/services/design/design-snapshot-history.ts";
import {
  createShareLink, previewShareRepin, updateShareLink,
} from "../../../src/services/design/share/design-share-links.service.ts";

const NONE = { added: [], removed: [], changed: [], truncated: false };

describe("share link re-pin preview", () => {
  let project: string;
  let dir: string;
  let previousAuth: ReturnType<typeof configService.get<"auth">>;

  beforeEach(async () => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-share-preview-")));
    await createDesign(project, { title: "Home", kind: "page" });
    dir = join(project, "designs", "home");
    previousAuth = { ...configService.get("auth") };
    configService.set("auth", { ...previousAuth, enabled: true, token: "share-test" });
    getDb().exec("DELETE FROM design_share_links");
  });
  afterEach(() => {
    configService.set("auth", previousAuth);
    rmSync(project, { recursive: true, force: true });
  });

  const create = () => createShareLink(project, "home", { expiresAt: null, version: "current" });

  it("lists nothing for an unchanged design", async () => {
    const link = await create();
    expect(await previewShareRepin(project, "home", link.id)).toEqual(NONE);
  });

  it("lists edited, added and removed files before the re-pin, and the re-pin then agrees", async () => {
    writeFileSync(join(dir, "old.css"), "a{}");
    const link = await create();
    writeFileSync(join(dir, "index.html"), "<p>new</p>");
    rmSync(join(dir, "old.css"));
    writeFileSync(join(dir, "new.css"), "b{}");
    const expected = { added: ["new.css"], removed: ["old.css"], changed: ["index.html"], truncated: false };

    expect(await previewShareRepin(project, "home", link.id)).toEqual(expected);
    // The preview pins nothing: the link still holds its old snapshot.
    const after = (await updateShareLink(project, "home", link.id, { repin: true }));
    expect(after.changedFiles).toEqual(expected);
    expect(await previewShareRepin(project, "home", link.id)).toEqual(NONE);
  });

  it("leaves out the design's own .design/ data, as a snapshot does", async () => {
    const link = await create();
    mkdirSync(join(dir, ".design"), { recursive: true });
    writeFileSync(join(dir, ".design", "scratch.json"), "{}");
    expect(await previewShareRepin(project, "home", link.id)).toEqual(NONE);
  });

  it("answers null once the pinned snapshot is gone", async () => {
    const link = await create();
    rmSync(snapshotDir(dir, link.snapshotId), { recursive: true, force: true });
    expect(await previewShareRepin(project, "home", link.id)).toBeNull();
  });

  it("refuses a revoked link, which cannot be re-pinned", async () => {
    const link = await create();
    await updateShareLink(project, "home", link.id, { revoke: true });
    await expect(previewShareRepin(project, "home", link.id)).rejects.toMatchObject({ status: 409, code: "revoked" });
  });
});
