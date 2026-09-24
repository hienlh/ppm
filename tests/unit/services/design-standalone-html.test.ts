import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStandaloneHtml } from "../../../src/services/design/export/design-standalone-html.ts";
import { createDesignAssetReader, type ReadAsset } from "../../../src/services/design/export/design-export-asset-reader.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const posix = process.platform !== "win32";

function memoryReader(files: Record<string, string>): ReadAsset {
  return async (rel, max) => {
    const body = files[rel];
    if (body === undefined) return { ok: false, reason: "missing" };
    if (body.length > max) return { ok: false, reason: "too-large" };
    return { ok: true, bytes: new TextEncoder().encode(body) };
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="styles.css" media="screen">
<link rel="stylesheet" href="../tokens.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/x/x.css">
<script src="https://unpkg.com/alpinejs" defer></script>
<script src="app.js"></script>
<script src="late.js" defer></script>
<script type="module" src="mod.js"></script>
<style>.hero{background:url(img/bg.png)}</style>
</head><body>
<img src="img/logo.png" srcset="img/logo.png 1x, img/logo@2x.png 2x" alt="Logo">
<div style="background-image:url('img/bg.png')">Hi</div>
<video src="clip.mp4" poster="img/poster.png"></video>
<img src="missing.png"><img src="../other/secret.png">
</body></html>`;

const FILES: Record<string, string> = {
  "index.html": PAGE,
  "styles.css": ".a{background:url(img/bg.png)}",
  "../tokens.css": ":root{--accent:#f00}",
  "app.js": "document.title = '</script> ok';",
  "late.js": "window.late = 1;",
  "mod.js": "import { x } from './util.js'; import('./lazy.js');",
  "img/bg.png": "BG",
  "img/logo.png": "LOGO",
  "img/poster.png": "POSTER",
  "clip.mp4": "MP4",
};

describe("buildStandaloneHtml", () => {
  it("inlines local stylesheets, scripts, images and media, and leaves CDN links alone", async () => {
    const { html, warnings } = await buildStandaloneHtml("index.html", memoryReader(FILES));
    expect(html).toContain(`<style media="screen">.a{background:url("data:image/png;base64,${b64("BG")}")}</style>`);
    expect(html).toContain("<style>:root{--accent:#f00}</style>");
    expect(html).toContain('<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/x/x.css">');
    expect(html).toContain('<script src="https://unpkg.com/alpinejs" defer></script>');
    expect(html).toContain("<script>document.title = '<\\/script> ok';</script>");
    expect(html).toContain(`<script src="data:text/javascript;base64,${b64("window.late = 1;")}" defer></script>`);
    expect(html).toContain('<script type="module">import { x }');
    expect(html).toContain(`.hero{background:url("data:image/png;base64,${b64("BG")}")}`);
    expect(html).toContain(`<img src="data:image/png;base64,${b64("LOGO")}" srcset="data:image/png;base64,${b64("LOGO")} 1x" alt="Logo">`);
    expect(html).toContain(`style="background-image:url(&quot;data:image/png;base64,${b64("BG")}&quot;)"`);
    expect(html).toContain(`<video src="data:video/mp4;base64,${b64("MP4")}" poster="data:image/png;base64,${b64("POSTER")}">`);
    expect(html).toContain('<img src="missing.png"><img src="../other/secret.png">');
    expect(warnings).toEqual(expect.arrayContaining([
      "mod.js: imports ./util.js, which is not bundled",
      "mod.js: imports ./lazy.js, which is not bundled",
      "img/logo.png: srcset keeps only its first image",
      "missing.png: not found, left linked",
      "../other/secret.png: outside the design folder, left linked",
    ]));
  });

  it("splices without re-serialising: untouched markup stays byte-for-byte", async () => {
    const page = "<!DOCTYPE html>\r\n<HTML><Head><meta charset=utf-8></Head><BODY class=x>\r\n<p   data-a='1'>Hé</p><IMG SRC=a.png></BODY></HTML>";
    const { html } = await buildStandaloneHtml("index.html", memoryReader({ "index.html": page, "a.png": "A" }));
    expect(html).toBe(page.replace("SRC=a.png", `src="data:image/png;base64,${b64("A")}"`));
  });

  it("adds a charset when the page declares none, so a file opened from disk reads as UTF-8", async () => {
    const { html } = await buildStandaloneHtml("index.html", memoryReader({ "index.html": "<html><head><title>x</title></head><body>é</body></html>" }));
    expect(html).toBe('<html><head><meta charset="utf-8"><title>x</title></head><body>é</body></html>');
  });

  it("enforces the per-asset and total budgets, keeping the links", async () => {
    const files = { "index.html": '<img src="a.png"><img src="b.png"><img src="c.png">', "a.png": "x".repeat(10), "b.png": "y".repeat(30), "c.png": "z".repeat(10) };
    const { html, warnings } = await buildStandaloneHtml("index.html", memoryReader(files), { perAsset: 20, total: 15 });
    expect(html).toContain(`src="data:image/png;base64,${b64("x".repeat(10))}"`);
    expect(html).toContain('<img src="b.png"><img src="c.png">');
    expect(warnings).toEqual(["b.png: larger than 1 KB, left linked", "c.png: the export's size limit is used up, left linked"]);
  });

  it("fails for a page it cannot read", async () => {
    await expect(buildStandaloneHtml("gone.html", memoryReader({}))).rejects.toMatchObject({ status: 404 });
  });
});

describe("the production asset reader", () => {
  let designs: string;
  let outside: string;
  beforeEach(() => {
    designs = join(realpathSync(mkdtempSync(join(tmpdir(), "ppm-standalone-"))), "designs");
    outside = realpathSync(mkdtempSync(join(tmpdir(), "ppm-standalone-out-")));
    mkdirSync(join(designs, "landing", ".design"), { recursive: true });
    writeFileSync(join(designs, "landing", "a.png"), "A");
    writeFileSync(join(designs, "landing", "notes.txt"), "not a web asset");
    writeFileSync(join(designs, "landing", ".design", "comments.json"), "[]");
    writeFileSync(join(designs, "tokens.css"), ":root{}");
    writeFileSync(join(outside, "ppm.db"), "SQLite format 3");
  });
  afterEach(() => {
    rmSync(join(designs, ".."), { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("reads web assets in the design and tokens.css, and refuses everything else", async () => {
    const read = createDesignAssetReader(join(designs, "landing"), designs);
    expect(await read("a.png", 100)).toMatchObject({ ok: true });
    expect(await read("../tokens.css", 100)).toMatchObject({ ok: true });
    expect(await read("missing.png", 100)).toEqual({ ok: false, reason: "missing" });
    expect(await read("a.png", 0)).toEqual({ ok: false, reason: "too-large" });
    for (const rel of ["notes.txt", ".design/comments.json", "../landing/a.png", "../../x.png", "a\\b.png"]) {
      expect(await read(rel, 100)).toEqual({ ok: false, reason: "refused" });
    }
  });

  it.if(posix)("refuses a symlink, even one named like an image", async () => {
    symlinkSync(join(outside, "ppm.db"), join(designs, "landing", "db.png"));
    symlinkSync(join(designs, "landing", "a.png"), join(designs, "landing", "alias.png"));
    const read = createDesignAssetReader(join(designs, "landing"), designs);
    expect(await read("db.png", 100)).toEqual({ ok: false, reason: "refused" });
    expect(await read("alias.png", 100)).toEqual({ ok: false, reason: "refused" });
  });
});
