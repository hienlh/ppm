/**
 * Writes that do their harm later and somewhere else — a hook git runs on the next commit,
 * instructions another chat in the folder obeys, a config the user's own tools load — and
 * the path shapes that reach a file a protected name would have refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { join } from "node:path";
import { extensionToolDecision } from "../../../src/providers/extension-tool-policy.ts";
import { expandBraces, namesAlternateStream, patternLeavesRoot } from "../../../src/services/tool-path-scope.ts";
import { hooksPathInConfig } from "../../../src/services/git-hooks-dirs.ts";
import type { ExtensionToolPolicy } from "../../../src/shared/extension-session-binding.ts";

let base: string;
let root: string;
let policy: ExtensionToolPolicy;

const decide = (tool: string, input: unknown, p: ExtensionToolPolicy = policy) => extensionToolDecision(tool, input, p, root);
const allowed = (tool: string, input: unknown, p?: ExtensionToolPolicy) => decide(tool, input, p).decision === "allow";

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ext-tool-side-effects-")));
  root = join(base, "repo");
  // A repository whose hooks live in a folder of its own choosing.
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n[core]\n\thooksPath = tools/git-hooks ; set by the repo\n");
  // A worktree below it, whose `.git` is a file pointing into the main repository.
  mkdirSync(join(root, ".git", "worktrees", "p1"), { recursive: true });
  writeFileSync(join(root, ".git", "worktrees", "p1", "commondir"), "../..\n");
  mkdirSync(join(root, ".proposals", "p1"), { recursive: true });
  writeFileSync(join(root, ".proposals", "p1", ".git"), `gitdir: ${join(root, ".git", "worktrees", "p1")}\n`);
  policy = { readRoots: [root], writeRoots: [root] };
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("files that run or steer code later", () => {
  it("refuses agent instructions, hook folders, MCP and direnv files at any depth", () => {
    for (const rel of ["CLAUDE.md", "docs/CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "pkg/AGENTS.override.md",
      ".husky/pre-commit", ".githooks/pre-push", ".mcp.json", ".envrc", ".codex/config.toml", ".vscode/tasks.json",
      ".npmrc", ".yarnrc.yml", ".pnpmfile.cjs", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"]) {
      const verdict = decide("Write", { file_path: join(root, ".proposals", "p1", ...rel.split("/")) });
      expect({ rel, verdict: verdict.decision }).toEqual({ rel, verdict: "deny" });
    }
    expect(allowed("Write", { file_path: join(root, "docs", "claude-notes.md") })).toBe(true);
    expect(allowed("Write", { file_path: join(root, "src", "agents.ts") })).toBe(true);
  });

  it("refuses the hooks folder the repository's own git config names, from the repo and from a worktree", () => {
    expect(decide("Write", { file_path: join(root, "tools", "git-hooks", "pre-commit") })).toEqual({
      decision: "deny", reason: `${join(root, "tools", "git-hooks", "pre-commit")} is protected and cannot be written`,
    });
    expect(allowed("Write", { file_path: join(root, ".proposals", "p1", "tools", "git-hooks", "pre-commit") })).toBe(false);
    expect(allowed("Write", { file_path: join(root, "tools", "build.ts") })).toBe(true);
  });

  it("reads core.hooksPath the way git does, and nothing else", () => {
    expect(hooksPathInConfig("[core]\n\thooksPath = .husky/_\n")).toBe(".husky/_");
    expect(hooksPathInConfig("[CORE]\n  HooksPath=\"hooks dir\" # quoted\n")).toBe("hooks dir");
    expect(hooksPathInConfig("[core] hooksPath = inline\n")).toBe("inline");
    expect(hooksPathInConfig("[core]\nhooksPath = a\n[core]\nhooksPath = b\n")).toBe("b");
    expect(hooksPathInConfig("[remote \"core\"]\nhooksPath = no\n[user]\nhooksPath = no\n")).toBeNull();
    expect(hooksPathInConfig("; [core]\n# hooksPath = no\n")).toBeNull();
  });
});

describe("credentials beside the CLI folders", () => {
  it("refuses the user-level Claude, git and package-manager configs even inside a root", () => {
    const home: ExtensionToolPolicy = { readRoots: [homedir(), tmpdir()], writeRoots: [homedir(), tmpdir()] };
    for (const file of ["~/.claude.json", "~/.gitconfig", "~/.git-credentials", "~/.config/git/config", "~/.config/gh/hosts.yml",
      "~/.npmrc", "~/.yarnrc.yml", "~/.bunfig.toml", "~/.netrc", "~/.aws/credentials", "~/.docker/config.json", "~/.kube/config"]) {
      expect(decide("Read", { file_path: file }, home)).toEqual({ decision: "deny", reason: `${file} holds credentials and is off limits` });
      expect(decide("Write", { file_path: file }, home).decision).toBe("deny");
    }
    expect(allowed("Read", { file_path: join(root, "README.md") }, home)).toBe(true);
  });
});

describe("Glob patterns that could leave their directory", () => {
  it("refuses a `..` anywhere and any brace expansion that leaves or goes absolute", () => {
    for (const pattern of ["{a,..}/**", "{.,x}./**", "src/{,../}**", "x/..", "a..b/*", "{/etc,src}/*", "{a,{b,/c}}/*", "{~,x}/**"]) {
      expect({ pattern, left: patternLeavesRoot(pattern) }).toEqual({ pattern, left: true });
      expect(allowed("Glob", { pattern })).toBe(false);
    }
    for (const pattern of ["**/*.{ts,tsx}", "src/{a,b}/**/*.ts", "{src,tests}/**/{x,y}.ts", "a{b/*"]) {
      expect({ pattern, left: patternLeavesRoot(pattern) }).toEqual({ pattern, left: false });
    }
  });

  it("expands braces, nested ones included, and gives up past the limit", () => {
    expect(expandBraces("a/{b,c}/d")?.sort()).toEqual(["a/b/d", "a/c/d"]);
    expect(expandBraces("{x,{y,z}}.ts")?.sort()).toEqual(["x.ts", "y.ts", "z.ts"]);
    expect(expandBraces("a{b/*")).toEqual(["a{b/*"]);
    expect(expandBraces("{a,b}{c,d}{e,f}{g,h}{i,j}", 16)).toBeNull();
  });
});

describe("NTFS stream names", () => {
  it("finds a `:` past the root of a Windows path, and only there", () => {
    expect(namesAlternateStream("C:\\r\\secrets.json::$DATA", path.win32)).toBe(true);
    expect(namesAlternateStream("C:\\r\\package.json:x", path.win32)).toBe(true);
    expect(namesAlternateStream("\\\\?\\C:\\r\\x:y", path.win32)).toBe(true);
    expect(namesAlternateStream("\\\\server\\share\\x:y", path.win32)).toBe(true);
    expect(namesAlternateStream("C:\\r\\a.ts", path.win32)).toBe(false);
    expect(namesAlternateStream("\\\\?\\C:\\r\\a.ts", path.win32)).toBe(false);
    expect(namesAlternateStream("\\\\.\\C:\\r\\a.ts", path.win32)).toBe(false);
    expect(namesAlternateStream("\\\\server\\share\\a.ts", path.win32)).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("refuses a write through a stream name on Windows", () => {
    const withSecrets: ExtensionToolPolicy = { ...policy, protectedPaths: ["secrets.json"] };
    const verdict = decide("Write", { file_path: join(root, "secrets.json::$DATA") }, withSecrets);
    expect(verdict.decision).toBe("deny");
  });
});
