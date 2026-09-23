import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDesignDir, resolveDesignsRoot } from "../../../src/services/design/design-paths.ts";

const linkType = process.platform === "win32" ? "junction" : "dir";

describe("design path guard", () => {
  let project: string;
  let outside: string;

  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-paths-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-outside-")));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("resolves an existing design folder to its real path", async () => {
    mkdirSync(join(project, "designs", "landing"), { recursive: true });
    expect(await resolveDesignDir(project, "landing")).toBe(join(project, "designs", "landing"));
  });

  it("answers 404 for a design that does not exist, and for a missing designs/ folder", async () => {
    await expect(resolveDesignDir(project, "nope")).rejects.toMatchObject({ status: 404 });
    mkdirSync(join(project, "designs"));
    await expect(resolveDesignDir(project, "nope")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects slugs that could name anything but one folder", async () => {
    for (const slug of ["..", "../x", "a/b", "a\\b", "", "UPPER", "-lead", "c:", ".design"]) {
      await expect(resolveDesignDir(project, slug)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("refuses a symlinked designs/ folder instead of following it", async () => {
    mkdirSync(join(outside, "landing"));
    symlinkSync(outside, join(project, "designs"), linkType);
    await expect(resolveDesignsRoot(project)).rejects.toMatchObject({ status: 403 });
    await expect(resolveDesignDir(project, "landing")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a symlinked design folder", async () => {
    mkdirSync(join(project, "designs"));
    symlinkSync(outside, join(project, "designs", "landing"), linkType);
    await expect(resolveDesignDir(project, "landing")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a designs/ that is a file", async () => {
    writeFileSync(join(project, "designs"), "not a folder");
    await expect(resolveDesignsRoot(project)).rejects.toMatchObject({ status: 403 });
  });

  it("creates designs/ only when asked, and returns the would-be path of a new design", async () => {
    expect(await resolveDesignsRoot(project)).toBeNull();
    expect(await resolveDesignDir(project, "fresh", { mustExist: false })).toBe(join(project, "designs", "fresh"));
    expect(await resolveDesignsRoot(project)).toBe(join(project, "designs"));
  });
});
