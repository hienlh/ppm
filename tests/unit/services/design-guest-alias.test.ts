import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGuestAlias } from "../../../src/services/design/preview/design-guest-alias.ts";

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (e) {
    const err = e as { status?: number; code?: string };
    return err.status ?? (err.code === "ENOENT" ? 404 : 500);
  }
}

describe("guest alias allow-list", () => {
  let project: string;
  let designs: string;
  const design = () => ({ projectPath: project, slug: "home" });

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-guest-alias-")));
    designs = join(project, "designs");
    for (const slug of ["home", "other"]) {
      mkdirSync(join(designs, slug), { recursive: true });
      writeFileSync(join(designs, slug, "index.html"), `<p>${slug}</p>`);
      writeFileSync(join(designs, slug, "design.json"), "{}");
    }
    writeFileSync(join(designs, "tokens.css"), ":root{}");
    writeFileSync(join(designs, "DESIGN.md"), "# system");
    mkdirSync(join(designs, "kit", "icons"), { recursive: true });
    writeFileSync(join(designs, "kit", "x.css"), ".x{}");
    writeFileSync(join(designs, "kit", "icons", "a.svg"), "<svg/>");
    mkdirSync(join(designs, "systems", "acme", "kit"), { recursive: true });
    writeFileSync(join(designs, "systems", "acme", "tokens.css"), ":root{}");
    writeFileSync(join(designs, "systems", "acme", "system.json"), "{}");
    writeFileSync(join(designs, "systems", "acme", "kit", "y.css"), ".y{}");
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("serves the shared tokens and the default app's tokens and kit", async () => {
    expect(await statusOf(resolveGuestAlias(design(), "default", "tokens.css"))).toBe(200);
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/tokens.css"))).toBe(200);
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/kit/x.css"))).toBe(200);
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/kit/icons/a.svg"))).toBe(200);
    const asset = await resolveGuestAlias(design(), "default", "systems/default/kit/x.css");
    expect(asset.abs).toBe(join(designs, "kit", "x.css"));
    expect(asset.rel).toBe("../systems/default/kit/x.css");
  });

  it("refuses every other design and the live copy of the shared one", async () => {
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/other/index.html"))).toBe(403);
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/home/index.html"))).toBe(403);
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/home/design.json"))).toBe(403);
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/DESIGN.md"))).toBe(403);
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/kit"))).toBe(403);
    expect(await statusOf(resolveGuestAlias(design(), "default", "home/index.html"))).toBe(403);
  });

  it("serves only the snapshot's own app, never another app or its declaration", async () => {
    expect(await statusOf(resolveGuestAlias(design(), "acme", "systems/acme/tokens.css"))).toBe(200);
    expect(await statusOf(resolveGuestAlias(design(), "acme", "systems/acme/kit/y.css"))).toBe(200);
    expect(await statusOf(resolveGuestAlias(design(), "acme", "systems/acme/system.json"))).toBe(403);
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/acme/tokens.css"))).toBe(403);
    expect(await statusOf(resolveGuestAlias(design(), "acme", "systems/default/kit/x.css"))).toBe(403);
  });

  it("refuses traversal, dot segments and smuggled separators", async () => {
    for (const path of [
      "systems/default/kit/../home/index.html", "systems/default/kit/.hidden.css", "systems/default/./kit/x.css",
      "systems/default/kit//x.css", "systems\\default\\kit\\x.css", "systems/default/kit/x.css\0.png", "C:/x.css", "",
    ]) {
      expect(await statusOf(resolveGuestAlias(design(), "default", path))).toBe(403);
    }
  });

  it("refuses the default kit while a design named kit exists, and a kit that is a link", async () => {
    writeFileSync(join(designs, "kit", "design.json"), "{}");
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/kit/x.css"))).toBe(403);
    rmSync(join(designs, "kit"), { recursive: true, force: true });
    // A folder that is not a design, so only the containment check can refuse it.
    mkdirSync(join(designs, "elsewhere"));
    writeFileSync(join(designs, "elsewhere", "x.css"), ".secret{}");
    try {
      symlinkSync(join(designs, "elsewhere"), join(designs, "kit"), "junction");
    } catch {
      return; // no symlink permission on this host
    }
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/kit/x.css"))).toBe(403);
  });

  it("answers 404 for an allowed file that is missing", async () => {
    expect(await statusOf(resolveGuestAlias(design(), "default", "systems/default/kit/missing.css"))).toBe(404);
  });
});
