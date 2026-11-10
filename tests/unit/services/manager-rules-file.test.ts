/**
 * The rules file on disk: read only when it is a plain file of its own inside a real `.ppm`
 * folder; a file over the size limit is reported whole, never cut; writes replace a link rather
 * than writing through it; `.ppm/.gitignore` gets PPM's two lines appended once; git tells
 * whether the file is tracked.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRulesGitignore, readRulesFile, rulesFilePath, rulesFileTracked, writeRulesFile,
} from "../../../src/services/assistant-managers/manager-rules-file.ts";
import { RULES_FILE_MAX_BYTES } from "../../../src/shared/assistant-limits.ts";

let project: string;
beforeEach(() => { project = mkdtempSync(join(tmpdir(), "ppm-rules-file-")); });
afterEach(() => { rmSync(project, { recursive: true, force: true }); });

const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: project, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

describe("readRulesFile", () => {
  it("answers missing for no .ppm and for no file", async () => {
    expect(await readRulesFile(project)).toEqual({ kind: "missing" });
    mkdirSync(join(project, ".ppm"));
    expect(await readRulesFile(project)).toEqual({ kind: "missing" });
  });

  it("reads a plain file", async () => {
    await writeRulesFile(project, "- Never deploy on Fridays.\n");
    expect(await readRulesFile(project)).toEqual({ kind: "file", text: "- Never deploy on Fridays.\n" });
  });

  it("refuses a symlink, a hardlink and a directory", async () => {
    mkdirSync(join(project, ".ppm"));
    const elsewhere = join(project, "elsewhere.md");
    writeFileSync(elsewhere, "- anything goes\n");
    symlinkSync(elsewhere, rulesFilePath(project));
    expect(await readRulesFile(project)).toEqual({ kind: "unsafe", reason: "symlink", replaceable: true });
    rmSync(rulesFilePath(project));
    linkSync(elsewhere, rulesFilePath(project));
    expect(await readRulesFile(project)).toEqual({ kind: "unsafe", reason: "hardlink", replaceable: true });
    rmSync(rulesFilePath(project));
    mkdirSync(rulesFilePath(project));
    expect(await readRulesFile(project)).toEqual({ kind: "unsafe", reason: "not_a_file", replaceable: false });
  });

  it("refuses a .ppm that is a link", async () => {
    mkdirSync(join(project, "real"));
    symlinkSync(join(project, "real"), join(project, ".ppm"), "dir");
    expect(await readRulesFile(project)).toEqual({ kind: "unsafe", reason: "dir_unsafe", replaceable: false });
    await expect(writeRulesFile(project, "x")).rejects.toThrow();
  });

  it("reports an oversize file whole", async () => {
    const big = "- rule\n".repeat(Math.ceil((RULES_FILE_MAX_BYTES + 10) / 7));
    await writeRulesFile(project, big);
    const read = await readRulesFile(project);
    expect(read).toMatchObject({ kind: "too_large", text: big });
  });
});

describe("writeRulesFile", () => {
  it("replaces a symlink instead of writing through it", async () => {
    mkdirSync(join(project, ".ppm"));
    const elsewhere = join(project, "elsewhere.md");
    writeFileSync(elsewhere, "theirs\n");
    symlinkSync(elsewhere, rulesFilePath(project));
    await writeRulesFile(project, "ours\n");
    expect(readFileSync(elsewhere, "utf8")).toBe("theirs\n");
    expect(await readRulesFile(project)).toEqual({ kind: "file", text: "ours\n" });
  });

  it("does not create the project folder", async () => {
    await expect(writeRulesFile(join(project, "gone"), "x")).rejects.toThrow();
  });
});

describe(".ppm/.gitignore", () => {
  it("is written with PPM's two lines, appended to what is there, once", async () => {
    mkdirSync(join(project, ".ppm"));
    writeFileSync(join(project, ".ppm", ".gitignore"), "/notes.md");
    await ensureRulesGitignore(project);
    await ensureRulesGitignore(project);
    expect(readFileSync(join(project, ".ppm", ".gitignore"), "utf8")).toBe("/notes.md\n/manager.md\n/.gitignore\n");
  });

  it("never lists everything", async () => {
    await writeRulesFile(project, "x\n");
    expect(readFileSync(join(project, ".ppm", ".gitignore"), "utf8")).toBe("/manager.md\n/.gitignore\n");
  });
});

describe("rulesFileTracked", () => {
  it("answers untracked outside a repository and for an ignored file, tracked for a committed one", async () => {
    expect(await rulesFileTracked(project)).toBe("untracked");
    git("init", "-q");
    await writeRulesFile(project, "x\n");
    expect(await rulesFileTracked(project)).toBe("untracked");
    expect(git("status", "--porcelain", "--", ".ppm")).toBe("");
    git("add", "-f", ".ppm/manager.md");
    expect(await rulesFileTracked(project)).toBe("tracked");
  });
});
