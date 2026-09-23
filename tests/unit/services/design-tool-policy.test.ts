/**
 * Design permission policy.
 *
 * Why PPM decides instead of leaning on the SDK's own `acceptEdits`: in the CLI bundled
 * with the pinned SDK, acceptEdits auto-allows a file edit only when the path passes the
 * working-directory membership check (`mode==="acceptEdits"&&T` where `T` is that check),
 * so edits outside the cwd would still ask — but the same mode also auto-allows a set of
 * filesystem shell commands (`mode==="acceptEdits"&&Kwr(s)` in the Bash permission path).
 * A design session wants "shell always asks", so the PreToolUse hook answers explicitly
 * for every tool and this policy is the authority either way.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { designToolDecision } from "../../../src/services/design/design-tool-policy.ts";

let base: string;
let project: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "ppm-design-policy-"));
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(project, "designs", "smoke"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(project, "designs", "smoke", "index.html"), "<h1>hi</h1>");
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(project, "escape"), "dir");
  symlinkSync(join(outside, "not-there-yet.txt"), join(project, "dangling.txt"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("designToolDecision — file tools inside the project", () => {
  it("allows reads, writes and edits of project files", () => {
    expect(designToolDecision("Read", { file_path: join(project, "designs/smoke/index.html") }, project)).toBe("allow");
    expect(designToolDecision("Read", { file_path: "designs/smoke/index.html" }, project)).toBe("allow");
    expect(designToolDecision("Edit", { file_path: "designs/smoke/index.html", old_string: "a", new_string: "b" }, project)).toBe("allow");
  });

  it("allows creating a file whose folders do not exist yet", () => {
    expect(designToolDecision("Write", { file_path: "designs/new-one/assets/app.css", content: "" }, project)).toBe("allow");
  });

  it("allows Glob and Grep scoped to the project, including with no path", () => {
    expect(designToolDecision("Glob", { pattern: "designs/**/*.html" }, project)).toBe("allow");
    expect(designToolDecision("Glob", { pattern: "*.css", path: "designs" }, project)).toBe("allow");
    expect(designToolDecision("Grep", { pattern: "hi" }, project)).toBe("allow");
    expect(designToolDecision("Grep", { pattern: "hi", path: join(project, "designs") }, project)).toBe("allow");
  });
});

describe("designToolDecision — anything that leaves the project asks", () => {
  it("asks for a path climbing out with ../", () => {
    expect(designToolDecision("Read", { file_path: "../outside/secret.txt" }, project)).toBe("ask");
    expect(designToolDecision("Write", { file_path: "designs/../../outside/x.txt" }, project)).toBe("ask");
  });

  it("asks for an absolute path outside", () => {
    expect(designToolDecision("Read", { file_path: join(outside, "secret.txt") }, project)).toBe("ask");
    expect(designToolDecision("Grep", { pattern: "x", path: outside }, project)).toBe("ask");
  });

  it("asks when a symlink inside the project points outside it", () => {
    expect(designToolDecision("Read", { file_path: "escape/secret.txt" }, project)).toBe("ask");
    expect(designToolDecision("Write", { file_path: "escape/new.txt" }, project)).toBe("ask");
  });

  it("asks for a dangling symlink, which a Write would follow out", () => {
    expect(designToolDecision("Write", { file_path: "dangling.txt" }, project)).toBe("ask");
  });

  it("asks for the home directory, however it is spelled", () => {
    expect(designToolDecision("Read", { file_path: "~/.ssh/id_ed25519" }, project)).toBe("ask");
    expect(designToolDecision("Read", { file_path: join(homedir(), ".ssh", "id_ed25519") }, project)).toBe("ask");
  });

  it("asks for a Glob pattern that is itself a path out", () => {
    expect(designToolDecision("Glob", { pattern: "../**/*" }, project)).toBe("ask");
    expect(designToolDecision("Glob", { pattern: "/etc/*" }, project)).toBe("ask");
    expect(designToolDecision("Glob", { pattern: "~/.ssh/*" }, project)).toBe("ask");
    expect(designToolDecision("Glob", {}, project)).toBe("ask");
  });
});

describe("designToolDecision — fail-closed", () => {
  it("asks for shell, web, MCP, subagents and unknown tools", () => {
    for (const tool of ["Bash", "WebFetch", "WebSearch", "mcp__x", "mcp__github__create_issue", "Agent", "Skill", "NotebookEdit", "Whatever"]) {
      expect(designToolDecision(tool, { file_path: "designs/smoke/index.html", command: "ls" }, project)).toBe("ask");
    }
  });

  it("asks without a project root, or with malformed input", () => {
    expect(designToolDecision("Read", { file_path: "designs/smoke/index.html" }, undefined)).toBe("ask");
    expect(designToolDecision("Read", { file_path: "" }, project)).toBe("ask");
    expect(designToolDecision("Read", {}, project)).toBe("ask");
    expect(designToolDecision("Read", { file_path: 42 }, project)).toBe("ask");
    expect(designToolDecision("Read", null, project)).toBe("ask");
    expect(designToolDecision("Grep", { pattern: "x", path: ["a"] }, project)).toBe("ask");
  });
});
