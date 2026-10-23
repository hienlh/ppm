import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { join } from "node:path";
import {
  ALWAYS_PROTECTED_PATHS, clampBoundPermissionMode, extensionToolDecision,
} from "../../../src/providers/extension-tool-policy.ts";
import { isInsideWith, matchesProtectedPath } from "../../../src/services/tool-path-scope.ts";
import { getPpmDir } from "../../../src/services/ppm-dir.ts";
import type { ExtensionToolPolicy } from "../../../src/shared/extension-session-binding.ts";

let base: string;
let r: string;
let outside: string;
let policy: ExtensionToolPolicy;

const decide = (tool: string, input: unknown, p: ExtensionToolPolicy = policy, cwd = r) => extensionToolDecision(tool, input, p, cwd);
const allowed = (tool: string, input: unknown, p?: ExtensionToolPolicy, cwd?: string) => decide(tool, input, p, cwd).decision === "allow";
const reason = (tool: string, input: unknown) => {
  const verdict = decide(tool, input);
  return verdict.decision === "deny" ? verdict.reason : "";
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ext-tool-policy-")));
  r = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(r, "src"), { recursive: true });
  mkdirSync(join(r, ".proposals", "1"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(r, "src", "a.ts"), "a");
  writeFileSync(join(r, ".proposals", "1", "a.ts"), "a");
  writeFileSync(join(r, ".proposals", "1", "shared.ts"), "s");
  writeFileSync(join(outside, "secret.txt"), "s");
  // A folder inside the write root that leads outside it, a link to a file inside it, a hard
  // link, and a link whose target is gone.
  symlinkSync(outside, join(r, ".proposals", "escape"), "dir");
  symlinkSync(join(r, ".proposals", "1", "a.ts"), join(r, ".proposals", "1", "link.ts"));
  linkSync(join(r, ".proposals", "1", "shared.ts"), join(r, ".proposals", "1", "hard.ts"));
  symlinkSync(join(base, "gone.ts"), join(r, ".proposals", "1", "dangling.ts"));
  policy = { readRoots: [r], writeRoots: [join(r, ".proposals")], protectedPaths: ["src/config/**"] };
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("extensionToolDecision — reads", () => {
  it("reads inside the read roots and nowhere else", () => {
    expect(allowed("Read", { file_path: join(r, "src", "a.ts") })).toBe(true);
    expect(allowed("Read", { file_path: "src/a.ts" })).toBe(true);
    expect(allowed("Read", { file_path: join(outside, "secret.txt") })).toBe(false);
    expect(allowed("Read", { file_path: "../outside/secret.txt" })).toBe(false);
    expect(allowed("Read", { file_path: join(r, ".proposals", "escape", "secret.txt") })).toBe(false);
    expect(allowed("Read", {})).toBe(false);
    expect(allowed("Read", { file_path: 42 })).toBe(false);
  });

  it("refuses credential folders even inside a read root", () => {
    expect(allowed("Read", { file_path: "~/.ssh/id_ed25519" })).toBe(false);
    const home: ExtensionToolPolicy = { readRoots: [homedir(), tmpdir()], writeRoots: [] };
    for (const file of ["~/.ssh/id_ed25519", "~/.claude/.credentials.json", "~/.codex/auth.json", "~/.cloudflared/cert.pem", join(getPpmDir(), "ppm.db")]) {
      const verdict = decide("Read", { file_path: file }, home);
      expect(verdict).toEqual({ decision: "deny", reason: `${file} holds credentials and is off limits` });
    }
    expect(allowed("Read", { file_path: join(r, "src", "a.ts") }, home)).toBe(true);
  });

  it("keeps Glob and Grep inside the roots, path and pattern alike", () => {
    expect(allowed("Glob", { pattern: "**/*.ts" })).toBe(true);
    expect(allowed("Glob", { pattern: "**/*.ts", path: "src" })).toBe(true);
    expect(allowed("Glob", { pattern: "../**" })).toBe(false);
    expect(allowed("Glob", { pattern: "/etc/*" })).toBe(false);
    expect(allowed("Glob", {})).toBe(false);
    expect(allowed("Grep", { pattern: "x" })).toBe(true);
    expect(allowed("Grep", { pattern: "x", path: outside })).toBe(false);
    // With no path the search runs in the session's directory, which here is outside.
    expect(allowed("Grep", { pattern: "x" }, policy, outside)).toBe(false);
  });
});

describe("extensionToolDecision — writes", () => {
  const w = (...parts: string[]) => join(r, ".proposals", ...parts);

  it("writes inside the write roots only, through every write tool", () => {
    expect(allowed("Write", { file_path: w("1", "new.ts") })).toBe(true);
    expect(allowed("Write", { file_path: w("2", "deep", "new.ts") })).toBe(true);
    expect(allowed("Edit", { file_path: w("1", "a.ts") })).toBe(true);
    expect(allowed("MultiEdit", { file_path: w("1", "a.ts") })).toBe(true);
    expect(allowed("NotebookEdit", { notebook_path: w("1", "n.ipynb") })).toBe(true);
    expect(allowed("NotebookEdit", { file_path: w("1", "n.ipynb") })).toBe(false);
    expect(allowed("Write", { file_path: join(r, "src", "a.ts") })).toBe(false);
    expect(allowed("Write", { file_path: w("..", "src", "a.ts") })).toBe(false);
    expect(allowed("Edit", { file_path: join(outside, "secret.txt") })).toBe(false);
  });

  it("refuses a symlinked parent, a symlinked or hard-linked target and a dangling link", () => {
    expect(allowed("Write", { file_path: w("escape", "x.ts") })).toBe(false);
    expect(reason("Write", { file_path: w("1", "link.ts") })).toContain("symbolic link");
    expect(reason("Edit", { file_path: w("1", "hard.ts") })).toContain("hard-linked");
    expect(reason("Edit", { file_path: w("1", "shared.ts") })).toContain("hard-linked");
    expect(allowed("Write", { file_path: w("1", "dangling.ts") })).toBe(false);
  });

  it("refuses protected paths at any depth below the root", () => {
    for (const rel of ["package.json", ".git/config", ".git", ".claude/settings.json", ".github/workflows/ci.yml",
      "node_modules/x/index.js", "bun.lock", "bun.lockb", "bunfig.toml", "src/config/limits.ts"]) {
      expect(reason("Write", { file_path: w("1", ...rel.split("/")) })).toContain("protected");
    }
    expect(allowed("Write", { file_path: w("1", "src", "configured.ts") })).toBe(true);
    expect(allowed("Write", { file_path: w("1", "docs", "package.json.md") })).toBe(true);
    // The root itself is not a file to write.
    expect(allowed("Write", { file_path: w() })).toBe(false);
  });

  it("refuses the credential folders as write targets too", () => {
    const wide: ExtensionToolPolicy = { readRoots: [], writeRoots: [homedir(), tmpdir()] };
    expect(decide("Write", { file_path: "~/.claude/settings.json" }, wide).decision).toBe("deny");
    expect(decide("Write", { file_path: join(getPpmDir(), "x.txt") }, wide).decision).toBe("deny");
  });
});

describe("extensionToolDecision — every other tool", () => {
  it("denies questions, shell, subagents, web, skills, team tools and foreign MCP", () => {
    expect(decide("AskUserQuestion", { questions: [] })).toEqual({ decision: "deny", reason: "Hãy hỏi bằng tin nhắn thường trong chat" });
    expect(decide("ExitPlanMode", {})).toEqual({ decision: "deny", reason: "Hãy hỏi bằng tin nhắn thường trong chat" });
    for (const tool of ["Bash", "PowerShell", "Agent", "Task", "WebFetch", "WebSearch", "Skill", "TeamCreate", "SendMessage",
      "TodoWrite", "mcp__github__create_issue", "mcp__ppm-tabs__open_file", "mcp__ppm-db__db_query", "SomethingNew"]) {
      expect(decide(tool, {})).toEqual({ decision: "deny", reason: `${tool} is not available in this chat` });
    }
  });

  it("allows the extension's own MCP tools and the deferred-tool loader", () => {
    expect(allowed("mcp__ppm-ext__fg_notebook_read", {})).toBe(true);
    expect(allowed("ToolSearch", { query: "notebook" })).toBe(true);
  });

  it("widens by allowTools, but never past the file tools' path rules or a question", () => {
    const wider: ExtensionToolPolicy = { ...policy, allowTools: ["TodoWrite", "Write", "Read", "AskUserQuestion"] };
    expect(allowed("TodoWrite", { todos: [] }, wider)).toBe(true);
    expect(allowed("Write", { file_path: join(r, "src", "a.ts") }, wider)).toBe(false);
    expect(allowed("Read", { file_path: join(outside, "secret.txt") }, wider)).toBe(false);
    expect(allowed("AskUserQuestion", {}, wider)).toBe(false);
  });
});

describe("path helpers", () => {
  it("treats another drive as outside on Windows, and folds case there", () => {
    const inside = isInsideWith(path.win32, true);
    expect(inside("D:\\r\\a.ts", "C:\\r")).toBe(false);
    expect(inside("c:\\R\\a.ts", "C:\\r")).toBe(true);
    expect(inside("C:\\rx\\a.ts", "C:\\r")).toBe(false);
    expect(inside("C:\\r", "C:\\r")).toBe(true);
    expect(isInsideWith(path.posix, false)("/R/a", "/r")).toBe(false);
  });

  it("matches protected globs unanchored, segment by segment", () => {
    expect(matchesProtectedPath("1/package.json", ALWAYS_PROTECTED_PATHS, false)).toBe(true);
    expect(matchesProtectedPath("1/.git", ALWAYS_PROTECTED_PATHS, false)).toBe(true);
    expect(matchesProtectedPath("1/.git/hooks/pre-commit", ALWAYS_PROTECTED_PATHS, false)).toBe(true);
    expect(matchesProtectedPath("1/.gitignore", ALWAYS_PROTECTED_PATHS, false)).toBe(false);
    expect(matchesProtectedPath("1/Package.JSON", ALWAYS_PROTECTED_PATHS, true)).toBe(true);
    expect(matchesProtectedPath("1/Package.JSON", ALWAYS_PROTECTED_PATHS, false)).toBe(false);
    expect(matchesProtectedPath("1/src/improve/a/b.ts", ["src/improve/**"], false)).toBe(true);
    expect(matchesProtectedPath("1/src/autorun/run-budget.ts", ["src/autorun/run-budget.ts"], false)).toBe(true);
    expect(matchesProtectedPath("1/src/autorun/run-budget.test.ts", ["src/autorun/run-budget.ts"], false)).toBe(false);
    expect(matchesProtectedPath("1/e2e/x/.env", ["e2e/**"], false)).toBe(true);
    expect(matchesProtectedPath("1/a/b/x.ts", ["a/**/x.ts"], false)).toBe(true);
    expect(matchesProtectedPath("1/a.ts", ["*.ts?"], false)).toBe(false);
  });

  it("keeps a bound session out of bypass", () => {
    expect(clampBoundPermissionMode("bypassPermissions")).toBe("acceptEdits");
    expect(clampBoundPermissionMode(undefined)).toBe("acceptEdits");
    expect(clampBoundPermissionMode("anything")).toBe("acceptEdits");
    expect(clampBoundPermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(clampBoundPermissionMode("default")).toBe("default");
    expect(clampBoundPermissionMode("plan")).toBe("plan");
  });
});
