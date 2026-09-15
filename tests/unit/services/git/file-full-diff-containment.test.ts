import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { gitService } from "../../../../src/services/git.service";

/**
 * `fileFullDiff` reads one of its two sides off the filesystem, and `filePath`
 * arrives from a query string. Git refuses `HEAD:../secret.txt` on the other
 * side by itself; `path.resolve` refuses nothing, so the working-tree read was
 * the one door in this function that would hand back any file the process can
 * open. PPM is routinely reached through a public tunnel URL, so "behind auth"
 * is not the whole story.
 *
 * Real directories rather than mocks: the escape has to be attempted against an
 * actual filesystem for the containment rule to mean anything.
 */
let root: string;
let repo: string;

beforeAll(() => {
  root = mkdtempSync(resolve(tmpdir(), "ppm-full-diff-"));
  repo = resolve(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(resolve(root, "secret.txt"), "TOP SECRET");
  writeFileSync(resolve(repo, "tracked.txt"), "in the repo");
});

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("fileFullDiff stays inside the project", () => {
  test("reads a file that is inside it", async () => {
    const diff = await gitService.fileFullDiff(repo, "tracked.txt", "HEAD");
    expect(diff.modified).toBe("in the repo");
  });

  for (const escape of ["../secret.txt", "../../etc/passwd", "sub/../../secret.txt"]) {
    test(`refuses ${escape}`, async () => {
      const diff = await gitService.fileFullDiff(repo, escape, "HEAD");
      expect(diff.modified).toBe("");
      expect(diff.modifiedSize).toBeNull();
    });
  }

  test("refuses an absolute path", async () => {
    const diff = await gitService.fileFullDiff(repo, resolve(root, "secret.txt"), "HEAD");
    expect(diff.modified).toBe("");
  });

  test("refuses a NUL byte rather than letting the syscall truncate it", async () => {
    const diff = await gitService.fileFullDiff(repo, "tracked.txt\0../secret.txt", "HEAD");
    expect(diff.modified).toBe("");
  });
});
