import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { isValidResourceName, resolveCreateTarget } from "../../../../src/services/ai-resources/path-safety.ts";

describe("isValidResourceName", () => {
  it("accepts safe names", () => {
    for (const n of ["research", "code-review", "my_agent", "a.b.c", "Deploy2"]) {
      expect(isValidResourceName(n)).toBe(true);
    }
  });

  it("rejects traversal and separators", () => {
    for (const n of ["../evil", "a/b", "a\\b", "..", ".hidden", "", "with space"]) {
      expect(isValidResourceName(n)).toBe(false);
    }
  });
});

describe("resolveCreateTarget", () => {
  const project = resolve("/tmp/proj");

  it("skills are dir-based with SKILL.md", () => {
    const { filePath } = resolveCreateTarget("skill", "project", "deploy", project);
    expect(filePath.replace(/\\/g, "/")).toBe(resolve(project, ".claude/skills/deploy/SKILL.md").replace(/\\/g, "/"));
  });

  it("agents and commands are flat .md files", () => {
    expect(resolveCreateTarget("agent", "project", "planner", project).filePath.replace(/\\/g, "/"))
      .toBe(resolve(project, ".claude/agents/planner.md").replace(/\\/g, "/"));
    expect(resolveCreateTarget("command", "project", "ship", project).filePath.replace(/\\/g, "/"))
      .toBe(resolve(project, ".claude/commands/ship.md").replace(/\\/g, "/"));
  });

  it("rejects invalid names", () => {
    expect(() => resolveCreateTarget("skill", "project", "../x", project)).toThrow();
  });

  it("project scope requires a project path", () => {
    expect(() => resolveCreateTarget("skill", "project", "x", "")).toThrow();
  });
});
