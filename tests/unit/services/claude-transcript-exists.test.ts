import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptExists } from "../../../src/services/claude-transcript-exists.ts";

describe("claudeTranscriptExists", () => {
  let root: string;
  let prev: string | undefined;

  beforeAll(() => {
    prev = process.env.CLAUDE_PROJECTS_DIR;
    root = mkdtempSync(join(tmpdir(), "claude-projects-"));
    mkdirSync(join(root, "d--some-project"));
    writeFileSync(join(root, "d--some-project", "9d0844ec-265a-4320-ad40-186c937de81d.jsonl"), "{}\n");
    process.env.CLAUDE_PROJECTS_DIR = root;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
    else process.env.CLAUDE_PROJECTS_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  });

  test("finds a transcript in any project folder", () => {
    expect(claudeTranscriptExists("9d0844ec-265a-4320-ad40-186c937de81d")).toBe(true);
  });

  test("answers false for an id with no transcript", () => {
    expect(claudeTranscriptExists("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  test("refuses ids that could leave the projects folder", () => {
    expect(claudeTranscriptExists("../d--some-project/9d0844ec-265a-4320-ad40-186c937de81d")).toBe(false);
  });
});
