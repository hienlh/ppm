import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzip } from "unzipit";
import { createDesignZip } from "../../../src/services/design/export/design-zip-export.ts";

const posix = process.platform !== "win32";

async function zipEntries(projectPath: string, slug: string): Promise<Record<string, string>> {
  const stream = await createDesignZip(projectPath, slug);
  const { entries } = await unzip(await new Response(stream).arrayBuffer());
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entries)) if (!entry.isDirectory) out[name] = await entry.text();
  return out;
}

describe("createDesignZip", () => {
  let project: string;
  let outside: string;
  let designs: string;

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-zip-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-zip-out-")));
    designs = join(project, "designs");
    mkdirSync(join(designs, "landing", ".design", "history"), { recursive: true });
    mkdirSync(join(designs, "landing", "img"), { recursive: true });
    mkdirSync(join(designs, "landing", ".git"), { recursive: true });
    writeFileSync(join(designs, "landing", "index.html"), "<link rel=stylesheet href=\"../tokens.css\"><p>Hi</p>");
    writeFileSync(join(designs, "landing", "img", "logo.png"), "png-bytes");
    writeFileSync(join(designs, "landing", "design.json"), "{\"title\":\"Landing\",\"kind\":\"page\"}");
    writeFileSync(join(designs, "landing", ".design", "comments.json"), "[]");
    writeFileSync(join(designs, "landing", ".git", "config"), "secret");
    writeFileSync(join(designs, "landing", ".env"), "KEY=1");
    writeFileSync(join(designs, "tokens.css"), ":root{--accent:#f00}");
    writeFileSync(join(designs, "DESIGN.md"), "# System");
    mkdirSync(join(designs, "other"));
    writeFileSync(join(designs, "other", "index.html"), "<p>other</p>");
    writeFileSync(join(outside, "ppm.db"), "SQLite format 3");
    writeFileSync(join(outside, "notes.txt"), "outside");
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("packs the design under its slug plus tokens.css and DESIGN.md, and nothing of .design or dotfiles", async () => {
    const entries = await zipEntries(project, "landing");
    expect(Object.keys(entries).sort()).toEqual([
      "DESIGN.md", "landing/design.json", "landing/img/logo.png", "landing/index.html", "tokens.css",
    ]);
    expect(entries["tokens.css"]).toBe(":root{--accent:#f00}");
    expect(entries["landing/img/logo.png"]).toBe("png-bytes");
  });

  it("leaves the shared files out when the project has none", async () => {
    rmSync(join(designs, "tokens.css"));
    rmSync(join(designs, "DESIGN.md"));
    expect(Object.keys(await zipEntries(project, "landing")).sort()).toEqual(["landing/design.json", "landing/img/logo.png", "landing/index.html"]);
  });

  it.if(posix)("skips a symlink to ppm.db, one escaping the folder, and a symlinked tokens.css", async () => {
    symlinkSync(join(outside, "ppm.db"), join(designs, "landing", "ppm.db"));
    symlinkSync(outside, join(designs, "landing", "escape"));
    symlinkSync(join(outside, "notes.txt"), join(designs, "landing", "img", "notes.txt"));
    rmSync(join(designs, "tokens.css"));
    symlinkSync(join(outside, "ppm.db"), join(designs, "tokens.css"));
    const entries = await zipEntries(project, "landing");
    const names = Object.keys(entries);
    expect(names).not.toContain("landing/ppm.db");
    expect(names.some((n) => n.startsWith("landing/escape"))).toBe(false);
    expect(names).not.toContain("landing/img/notes.txt");
    expect(names).not.toContain("tokens.css");
    expect(Object.values(entries).some((body) => body.includes("SQLite"))).toBe(false);
  });

  it("refuses an unknown design and a bad slug before streaming", async () => {
    await expect(createDesignZip(project, "missing")).rejects.toMatchObject({ status: 404 });
    await expect(createDesignZip(project, "../other")).rejects.toMatchObject({ status: 400 });
  });
});
