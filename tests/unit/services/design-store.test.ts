import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesign, deleteDesign, designSystemStatus, getDesign, listDesigns, renameDesign,
} from "../../../src/services/design/design-store.service.ts";
import { buildDesignSystemInitPrompt } from "../../../src/shared/design-system-init-prompt.ts";

describe("design store", () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-store-")));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("creates the entry page, the manifest and a git-ignoring .design/", async () => {
    const created = await createDesign(project, { title: "Landing page — v2", kind: "slides" });
    expect(created).toMatchObject({ slug: "landing-page-v2", title: "Landing page — v2", kind: "slides", entry: "index.html" });
    const dir = join(project, "designs", "landing-page-v2");
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain('<section class="slide">');
    expect(JSON.parse(readFileSync(join(dir, "design.json"), "utf8"))).toMatchObject({ kind: "slides", tweaks: [] });
    expect(readFileSync(join(dir, ".design", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("escapes the title in the starter page and links tokens.css when the project has one", async () => {
    mkdirSync(join(project, "designs"));
    writeFileSync(join(project, "designs", "tokens.css"), ":root{}");
    await createDesign(project, { title: "<script>alert(1)</script>", kind: "page" });
    const [design] = await listDesigns(project);
    const html = readFileSync(join(project, "designs", design!.slug, "index.html"), "utf8");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain('href="../tokens.css"');
  });

  it("keeps .design/ out of git", async () => {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: project });
    if (git("init", "-q").exitCode !== 0) return; // no git on this host
    await createDesign(project, { title: "Home", kind: "page" });
    mkdirSync(join(project, "designs", "home", ".design", "history", "x"), { recursive: true });
    writeFileSync(join(project, "designs", "home", ".design", "history", "x", "a.html"), "x");
    expect(git("check-ignore", "-q", "designs/home/.design/history/x/a.html").exitCode).toBe(0);
    const status = git("status", "--porcelain", "--untracked-files=all").stdout.toString();
    expect(status).toContain("designs/home/index.html");
    expect(status).not.toContain(".design");
  });

  it("gives a colliding slug a numeric suffix and rejects bad input", async () => {
    expect((await createDesign(project, { title: "Home", kind: "page" })).slug).toBe("home");
    expect((await createDesign(project, { title: "home", kind: "page" })).slug).toBe("home-2");
    expect((await createDesign(project, { title: "HOME!", kind: "page" })).slug).toBe("home-3");
    expect((await createDesign(project, { title: "日本", kind: "page" })).slug).toBe("design");
    await expect(createDesign(project, { title: "   ", kind: "page" })).rejects.toMatchObject({ status: 400 });
    await expect(createDesign(project, { title: "x", kind: "poster" })).rejects.toMatchObject({ status: 400 });
  });

  it("keeps the slug within 63 characters when suffixing", async () => {
    const long = "a".repeat(80);
    expect((await createDesign(project, { title: long, kind: "page" })).slug).toHaveLength(63);
    const second = await createDesign(project, { title: long, kind: "page" });
    expect(second.slug).toHaveLength(63);
    expect(second.slug.endsWith("-2")).toBe(true);
  });

  it("lists designs newest first, counting the entry file's mtime, and skips non-designs", async () => {
    await createDesign(project, { title: "Old", kind: "page" });
    await createDesign(project, { title: "New", kind: "page" });
    const old = join(project, "designs", "old", "index.html");
    const future = new Date(Date.now() + 60_000);
    utimesSync(old, future, future);
    mkdirSync(join(project, "designs", "assets-only"));
    mkdirSync(join(project, "designs", "Not_A_Slug"));
    writeFileSync(join(project, "designs", "Not_A_Slug", "index.html"), "x");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-store-out-")));
    writeFileSync(join(outside, "index.html"), "x");
    symlinkSync(outside, join(project, "designs", "linked"), process.platform === "win32" ? "junction" : "dir");
    try {
      expect((await listDesigns(project)).map((d) => d.slug)).toEqual(["old", "new"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns an empty list and no design system for a project without designs/", async () => {
    expect(await listDesigns(project)).toEqual([]);
    expect(await designSystemStatus(project)).toEqual({ designMd: false, tokensCss: false });
    mkdirSync(join(project, "designs"));
    writeFileSync(join(project, "designs", "DESIGN.md"), "# Design");
    expect(await designSystemStatus(project)).toEqual({ designMd: true, tokensCss: false });
  });

  it("asks the design system setup to write only DESIGN.md and tokens.css", () => {
    const prompt = buildDesignSystemInitPrompt();
    expect(prompt).toContain("designs/DESIGN.md");
    expect(prompt).toContain("designs/tokens.css");
    expect(prompt).toContain("do not modify any other file");
  });

  it("renames by title only and keeps the fields it does not own", async () => {
    await createDesign(project, { title: "Home", kind: "page" });
    const manifestPath = join(project, "designs", "home", "design.json");
    const edited = { ...JSON.parse(readFileSync(manifestPath, "utf8")), tweaks: [{ id: "r" }], agentNote: "keep" };
    writeFileSync(manifestPath, JSON.stringify(edited));
    const renamed = await renameDesign(project, "home", "Home page");
    expect(renamed).toMatchObject({ slug: "home", title: "Home page" });
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({ title: "Home page", tweaks: [{ id: "r" }], agentNote: "keep" });
    expect((await getDesign(project, "home")).title).toBe("Home page");
  });

  it("refuses to rename over a manifest that is not valid JSON", async () => {
    await createDesign(project, { title: "Home", kind: "page" });
    const manifestPath = join(project, "designs", "home", "design.json");
    writeFileSync(manifestPath, "{ broken");
    await expect(renameDesign(project, "home", "X")).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(manifestPath, "utf8")).toBe("{ broken");
  });

  it("deletes a design without following a symlink inside it", async () => {
    await createDesign(project, { title: "Home", kind: "page" });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-store-keep-")));
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(project, "designs", "home", "linked"), process.platform === "win32" ? "junction" : "dir");
    try {
      await deleteDesign(project, "home");
      expect(existsSync(join(project, "designs", "home"))).toBe(false);
      expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
      await expect(getDesign(project, "home")).rejects.toMatchObject({ status: 404 });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
