/**
 * The mkdir route answers `gitInitialized: true` whatever `git init` did, so the log line is the
 * only trace of a folder created without its repository.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitInit } from "../../../../src/services/fs-ops/fs-git-init.service.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-git-init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runGitInit", () => {
  it("logs an ERROR with the exit code when git init fails", async () => {
    writeFileSync(join(dir, "file"), "");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runGitInit(join(dir, "file", "repo")); // under a regular file: git cannot create it
      const lines = errors.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => /^\[fs\] git init failed in .*: exit \d+$/.test(line))).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it("logs no error when git init succeeds", async () => {
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runGitInit(join(dir, "repo"));
      expect(existsSync(join(dir, "repo", ".git"))).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});
