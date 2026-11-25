import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importClaudeMemories } from "../../../src/services/memory/import-claude.ts";

let root: string;
let claudeHome: string;
let projectPath: string;
let memoryDir: string;

const encode = (path: string) => realpathSync(path).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");

const FEEDBACK = `---
name: Bash tool shell is zsh
description: unquoted $LIST is one argument
type: feedback
---
The Bash tool runs zsh.

Quote your variables.
`;

const METADATA_TYPE = `---
name: user-likes-tea
description: anh drinks tea, not coffee
metadata:
  type: user
---
Tea at 3 pm.
`;

const UNKNOWN_TYPE = `---
name: odd one
description: has a type nobody knows
type: whatever
---
Body of the odd one.
`;

const NO_FRONTMATTER = `Plain note first line

More text below.
`;

const INDEX = `- [Bash tool shell is zsh](feedback-zsh.md) — index line
`;

function writeMemory(file: string, text: string) {
  writeFileSync(join(memoryDir, file), text);
}

/** Every file and folder under `dir`, with its bytes and mtime, so a run can be shown to change nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      const s = statSync(p);
      if (entry.isDirectory()) {
        out[`${p}/`] = String(s.mtimeMs);
        walk(p);
      } else {
        out[p] = `${s.mtimeMs}:${s.size}:${readFileSync(p, "base64")}`;
      }
    }
  };
  walk(dir);
  return out;
}

const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-import-claude-"));
  claudeHome = join(root, "claude-home");
  projectPath = join(root, "work", "my-proj");
  mkdirSync(projectPath, { recursive: true });
  memoryDir = join(claudeHome, "projects", encode(projectPath), "memory");
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("importClaudeMemories", () => {
  it("imports every topic file of the project's memory folder and skips MEMORY.md", async () => {
    writeMemory("feedback-zsh.md", FEEDBACK);
    writeMemory("user-likes-tea.md", METADATA_TYPE);
    writeMemory("MEMORY.md", INDEX);

    const result = await importClaudeMemories(projectPath, { claudeHome });

    expect(result.error).toBeUndefined();
    const items = byId(result.items);
    expect(items.map((m) => m.id)).toEqual(["claude-feedback-zsh", "claude-user-likes-tea"]);
    expect(items[0]).toMatchObject({
      id: "claude-feedback-zsh",
      scope: "project",
      name: "Bash tool shell is zsh",
      description: "unquoted $LIST is one argument",
      type: "feedback",
      body: "The Bash tool runs zsh.\n\nQuote your variables.",
      origin: join(memoryDir, "feedback-zsh.md"),
    });
    expect(items[0]!.originHash).toBeTruthy();
    expect(result.items.some((m) => m.body.includes("index line"))).toBe(false);
  });

  it("takes the type from the root or from metadata.type, and an unknown type becomes project", async () => {
    writeMemory("feedback-zsh.md", FEEDBACK);
    writeMemory("user-likes-tea.md", METADATA_TYPE);
    writeMemory("odd.md", UNKNOWN_TYPE);

    const items = byId((await importClaudeMemories(projectPath, { claudeHome })).items);

    expect(items.map((m) => [m.id, m.type])).toEqual([
      ["claude-feedback-zsh", "feedback"],
      ["claude-odd", "project"],
      ["claude-user-likes-tea", "user"],
    ]);
  });

  it("imports a file with no frontmatter: the file name is its name, the first body line its description", async () => {
    writeMemory("loose-note.md", NO_FRONTMATTER);

    const result = await importClaudeMemories(projectPath, { claudeHome });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: "claude-loose-note",
      scope: "project",
      name: "loose-note",
      description: "Plain note first line",
      type: "project",
      body: "Plain note first line\n\nMore text below.",
    });
  });

  it("reads only .md files directly in the folder", async () => {
    writeMemory("feedback-zsh.md", FEEDBACK);
    writeMemory("notes.txt", "not a memory");
    mkdirSync(join(memoryDir, "nested"));
    writeFileSync(join(memoryDir, "nested", "deep.md"), FEEDBACK);

    const items = (await importClaudeMemories(projectPath, { claudeHome })).items;

    expect(items.map((m) => m.id)).toEqual(["claude-feedback-zsh"]);
  });

  it("keeps the same originHash while the file is unchanged and a new one once it changes", async () => {
    writeMemory("feedback-zsh.md", FEEDBACK);
    const first = (await importClaudeMemories(projectPath, { claudeHome })).items[0]!;
    const again = (await importClaudeMemories(projectPath, { claudeHome })).items[0]!;
    expect(again.originHash).toBe(first.originHash);

    writeMemory("feedback-zsh.md", FEEDBACK.replace("Quote your variables.", "Quote every variable."));
    const changed = (await importClaudeMemories(projectPath, { claudeHome })).items[0]!;

    expect(changed.originHash).not.toBe(first.originHash);
    expect(changed.body).toContain("Quote every variable.");
  });

  it("gives two files with the same body but different names different ids", async () => {
    writeMemory("a.md", FEEDBACK);
    writeMemory("b.md", FEEDBACK);

    const items = byId((await importClaudeMemories(projectPath, { claudeHome })).items);

    expect(items.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
  });

  it("answers zero items and no error when the memory folder is missing", async () => {
    rmSync(join(claudeHome, "projects"), { recursive: true, force: true });

    const result = await importClaudeMemories(projectPath, { claudeHome });

    expect(result).toEqual({ items: [], skipped: [] });
  });

  it("answers zero items and no error when the Claude home itself is missing", async () => {
    const result = await importClaudeMemories(projectPath, { claudeHome: join(root, "no-such-home") });

    expect(result).toEqual({ items: [], skipped: [] });
  });

  it("never reads another project's folder, even one whose path starts the same", async () => {
    writeMemory("feedback-zsh.md", FEEDBACK);
    const other = join(root, "work", "my-proj-other");
    mkdirSync(other, { recursive: true });
    const otherDir = join(claudeHome, "projects", encode(other), "memory");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "secret-of-other.md"), UNKNOWN_TYPE);
    const parentDir = join(claudeHome, "projects", encode(join(root, "work")), "memory");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "parent.md"), METADATA_TYPE);

    const items = (await importClaudeMemories(projectPath, { claudeHome })).items;

    expect(items.map((m) => m.id)).toEqual(["claude-feedback-zsh"]);
  });

  it("finds the folder of the real path when the project is opened through a symlink", async () => {
    writeMemory("feedback-zsh.md", FEEDBACK);
    const link = join(root, "link-to-proj");
    symlinkSync(projectPath, link);

    const items = (await importClaudeMemories(link, { claudeHome })).items;

    expect(items.map((m) => m.id)).toEqual(["claude-feedback-zsh"]);
  });

  it("uses CLAUDE_CONFIG_DIR when no Claude home is passed", async () => {
    writeMemory("feedback-zsh.md", FEEDBACK);
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      const items = (await importClaudeMemories(projectPath, {})).items;
      expect(items.map((m) => m.id)).toEqual(["claude-feedback-zsh"]);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  it("creates, changes and deletes nothing in the Claude home", async () => {
    writeMemory("feedback-zsh.md", FEEDBACK);
    writeMemory("user-likes-tea.md", METADATA_TYPE);
    writeMemory("loose-note.md", NO_FRONTMATTER);
    writeMemory("MEMORY.md", INDEX);
    // Old mtimes, so a rewrite of the same bytes would still show.
    const old = new Date("2020-01-01T00:00:00Z");
    for (const f of readdirSync(memoryDir)) utimesSync(join(memoryDir, f), old, old);
    utimesSync(memoryDir, old, old);
    const before = snapshot(claudeHome);

    const result = await importClaudeMemories(projectPath, { claudeHome });

    expect(result.items).toHaveLength(3);
    expect(snapshot(claudeHome)).toEqual(before);
  });
});
