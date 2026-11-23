/**
 * PPM looks for a Claude transcript where the CLI it spawns writes one: under CLAUDE_CONFIG_DIR
 * when that is set. Reading ~/.claude instead made PPM resume conversations the CLI could not
 * find, or start over ones it still had.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, claudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { claudeTranscriptExists } from "../../../src/services/claude-transcript-exists.ts";
import { resolveSessionDir } from "../../../src/services/subagent-transcript-merger.ts";

const saved = { config: process.env.CLAUDE_CONFIG_DIR, projects: process.env.CLAUDE_PROJECTS_DIR };
afterEach(() => {
  if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.config;
  if (saved.projects === undefined) delete process.env.CLAUDE_PROJECTS_DIR; else process.env.CLAUDE_PROJECTS_DIR = saved.projects;
});

describe("where PPM looks for Claude transcripts", () => {
  it("is ~/.claude/projects without CLAUDE_CONFIG_DIR", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeConfigDir()).toBe(join(homedir(), ".claude"));
    expect(claudeProjectsRoot()).toBe(join(homedir(), ".claude", "projects"));
  });

  it("follows CLAUDE_CONFIG_DIR, read per call", () => {
    const config = mkdtempSync(join(tmpdir(), "claude-config-"));
    try {
      process.env.CLAUDE_CONFIG_DIR = config;
      delete process.env.CLAUDE_PROJECTS_DIR;
      expect(claudeProjectsRoot()).toBe(join(config, "projects"));
      const id = "6a1b0f4e-1111-4222-8333-944455556666";
      expect(resolveSessionDir(id, null)).toBeNull();
      expect(claudeTranscriptExists(id)).toBe(false);
      mkdirSync(join(config, "projects", "C--work-app"), { recursive: true });
      writeFileSync(join(config, "projects", "C--work-app", `${id}.jsonl`), "{}\n");
      expect(resolveSessionDir(id, null)).toBe(join(config, "projects", "C--work-app", id));
      expect(claudeTranscriptExists(id)).toBe(true);
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  });
});
