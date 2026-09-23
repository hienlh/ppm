import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScopedAsset } from "../../../src/services/design/preview/design-preview-scope.ts";

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
