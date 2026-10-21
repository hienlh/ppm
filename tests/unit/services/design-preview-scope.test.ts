import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScopedAsset, resolveSnapshotScopedPath } from "../../../src/services/design/preview/design-preview-scope.ts";

describe("design preview scope", () => {
  let project: string;
  const design = () => ({ projectPath: project, slug: "landing" });
  const status = async (path: string): Promise<number> => {
    try {
      await resolveScopedAsset(design(), path);
      return 200;
    } catch (e) {
      const err = e as { status?: number; code?: string };
      return err.status ?? (err.code === "ENOENT" ? 404 : 500);
    }
  };

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-scope-")));
    const designs = join(project, "designs");
    mkdirSync(join(designs, "landing", "img"), { recursive: true });
    mkdirSync(join(designs, "landing", ".design", "history"), { recursive: true });
    mkdirSync(join(designs, "other"), { recursive: true });
    writeFileSync(join(designs, "landing", "index.html"), "<p>landing</p>");
    writeFileSync(join(designs, "landing", "img", "a b.png"), "png");
    writeFileSync(join(designs, "landing", ".design", "history", "x.html"), "old");
    writeFileSync(join(designs, "landing", ".env.json"), "secret");
    writeFileSync(join(designs, "other", "index.html"), "<p>other</p>");
    writeFileSync(join(designs, "tokens.css"), ":root{}");
    writeFileSync(join(designs, "DESIGN.md"), "# system");
    writeFileSync(join(project, "secret.json"), "{}");
    mkdirSync(join(designs, "kit", "fonts"), { recursive: true });
    mkdirSync(join(designs, "kit", ".hidden"), { recursive: true });
    writeFileSync(join(designs, "kit", "app.css"), ":root{--kit:1}");
    writeFileSync(join(designs, "kit", "fonts", "a.woff2"), "font-bytes");
    writeFileSync(join(designs, "kit", ".env"), "secret");
    writeFileSync(join(designs, "kit", ".hidden", "x.css"), "hidden");
    // A second, declared app: its files live under designs/systems/<id>/, not the legacy root.
    mkdirSync(join(designs, "systems", "myapp", "kit"), { recursive: true });
    writeFileSync(join(designs, "systems", "myapp", "tokens.css"), ":root{--app:1}");
    writeFileSync(join(designs, "systems", "myapp", "kit", "app.css"), ":root{--appkit:1}");
  });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); });

  it("serves the design's own files", async () => {
    const asset = await resolveScopedAsset(design(), "landing/index.html");
    expect(asset).toMatchObject({ abs: join(project, "designs", "landing", "index.html"), rel: "index.html" });
    expect((await resolveScopedAsset(design(), "landing/img/a%20b.png")).rel).toBe("img/a b.png");
    expect((await resolveScopedAsset(design(), "landing/img/../index.html")).rel).toBe("index.html");
  });

  it("maps the single tokens.css alias to designs/tokens.css", async () => {
    const asset = await resolveScopedAsset(design(), "tokens.css");
    expect(asset).toMatchObject({ abs: join(project, "designs", "tokens.css"), rel: "../tokens.css" });
  });

  it("serves any file under systems/<id>/ for the default app, which remaps to the legacy designs/ root", async () => {
    const css = await resolveScopedAsset(design(), "systems/default/kit/app.css");
    expect(css).toMatchObject({ abs: join(project, "designs", "kit", "app.css"), rel: "../systems/default/kit/app.css" });
    const font = await resolveScopedAsset(design(), "systems/default/kit/fonts/a.woff2");
    expect(font).toMatchObject({ abs: join(project, "designs", "kit", "fonts", "a.woff2"), rel: "../systems/default/kit/fonts/a.woff2" });
    const tokens = await resolveScopedAsset(design(), "systems/default/tokens.css");
    expect(tokens).toMatchObject({ abs: join(project, "designs", "tokens.css") });
    for (const path of [
      "systems", "systems/", "systems/default", "systems/default/", "systems/default/kit/.env",
      "systems/default/kit/.hidden/x.css", "systems/default/kit/../tokens.css", "systems/default/kit/../../secret.json",
      "systems/Bad_Id/tokens.css", "systems/../tokens.css",
    ]) {
      expect(await status(path)).toBe(403);
    }
  });

  it("serves a declared app's own systems/<id>/ folder, never another app's", async () => {
    const css = await resolveScopedAsset(design(), "systems/myapp/kit/app.css");
    expect(css).toMatchObject({ abs: join(project, "designs", "systems", "myapp", "kit", "app.css"), rel: "../systems/myapp/kit/app.css" });
    const tokens = await resolveScopedAsset(design(), "systems/myapp/tokens.css");
    expect(tokens).toMatchObject({ abs: join(project, "designs", "systems", "myapp", "tokens.css") });
    // Climbing from inside one app's folder into another's, or out of systems/ entirely, is refused.
    for (const path of ["systems/myapp/../default/tokens.css", "systems/myapp/../../DESIGN.md"]) {
      expect(await status(path)).toBe(403);
    }
  });

  it("refuses another design, the design system notes and anything outside", async () => {
    for (const path of ["other/index.html", "DESIGN.md", "landing", "landing/", "landing/../other/index.html",
      "landing/..%2fother%2findex.html", "landing%2F..%2F..%2F..%2Fsecret.json", "landing/..%5c..%5csecret.json",
      "landing/index.html%00.png", "C:/x.html", "%E0%A4%A"]) {
      expect(await status(path)).toBe(403);
    }
  });

  it("never serves a dot-directory, including the design's own .design data", async () => {
    expect(await status("landing/.design/history/x.html")).toBe(403);
    expect(await status("landing/%2Edesign/history/x.html")).toBe(403);
    expect(await status("landing/.env.json")).toBe(403);
  });

  it("refuses a symlink out of the design and reports a missing file as ENOENT", async () => {
    symlinkSync(join(project, "designs", "other"), join(project, "designs", "landing", "link"), process.platform === "win32" ? "junction" : "dir");
    expect(await status("landing/link/index.html")).toBe(403);
    expect(await status("landing/missing.html")).toBe(404);
  });

  it("stops serving a design that was deleted after the token was minted", async () => {
    rmSync(join(project, "designs", "landing"), { recursive: true, force: true });
    expect(await status("landing/index.html")).toBe(404);
  });
});

describe("design snapshot scope", () => {
  let project: string;
  const SNAP = "20261021-120000-abcd";
  const design = () => ({ projectPath: project, slug: "landing" });
  const status = async (path: string, id = SNAP): Promise<number> => {
    try {
      await resolveSnapshotScopedPath(design(), id, path);
      return 200;
    } catch (e) {
      const err = e as { status?: number; code?: string };
      return err.status ?? (err.code === "ENOENT" ? 404 : 500);
    }
  };
  /** A complete snapshot directory, as the history module writes one. */
  const writeSnapshot = (dir: string, id: string) => {
    mkdirSync(join(dir, "files", "img"), { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      id, reason: "manual", createdAt: "2026-10-21T12:00:00.000Z", fileCount: 2, bytes: 10, treeHash: "0".repeat(64),
    }));
    writeFileSync(join(dir, "files", "index.html"), "<p>old</p>");
    writeFileSync(join(dir, "files", "img", "a.png"), "png");
    writeFileSync(join(dir, "files", ".env.json"), "secret");
  };
  const history = () => join(project, "designs", "landing", ".design", "history");
  const linkDir = (target: string, at: string) => symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-snapscope-")));
    mkdirSync(history(), { recursive: true });
    writeFileSync(join(project, "designs", "landing", "index.html"), "<p>live</p>");
    writeFileSync(join(project, "designs", "tokens.css"), ":root{}");
    writeSnapshot(join(history(), SNAP), SNAP);
  });
  afterEach(() => { rmSync(project, { recursive: true, force: true }); });

  it("serves the snapshot's copy of the design's own files, not the live one", async () => {
    const asset = await resolveSnapshotScopedPath(design(), SNAP, "landing/index.html");
    expect(asset).toMatchObject({ abs: join(history(), SNAP, "files", "index.html"), rel: "index.html" });
    expect(readFileSync(asset.abs, "utf8")).toBe("<p>old</p>");
    expect((await resolveSnapshotScopedPath(design(), SNAP, "landing/img/a.png")).rel).toBe("img/a.png");
  });

  it("reaches no alias, dot-file or path outside the snapshot", async () => {
    for (const path of ["tokens.css", "systems/default/tokens.css", "landing/.env.json", "landing/../../meta.json", `landing/..${String.fromCharCode(92)}x.html`, "other/index.html", "landing/"]) {
      expect(await status(path)).toBe(403);
    }
    expect(await status("landing/missing.html")).toBe(404);
  });

  it("404s an unknown or malformed snapshot id", async () => {
    expect(await status("landing/index.html", "20200101-000000-0000")).toBe(404);
    expect(await status("landing/index.html", "../history")).toBe(404);
  });

  it("refuses a snapshot directory that is a symlink, and a symlinked files/ inside a real one", async () => {
    const outside = join(project, "elsewhere");
    const LINKED = "20261021-130000-beef";
    writeSnapshot(join(outside, LINKED), LINKED);
    linkDir(join(outside, LINKED), join(history(), LINKED));
    expect(await status("landing/index.html", LINKED)).toBe(404);

    const REAL = "20261021-140000-cafe";
    mkdirSync(join(history(), REAL));
    writeFileSync(join(history(), REAL, "meta.json"), readFileSync(join(outside, LINKED, "meta.json"), "utf8").replace(LINKED, REAL));
    linkDir(join(outside, LINKED, "files"), join(history(), REAL, "files"));
    expect(await status("landing/index.html", REAL)).toBe(403);
  });
});
