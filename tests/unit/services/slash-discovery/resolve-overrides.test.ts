import { describe, it, expect } from "bun:test";
import { resolveOverrides } from "../../../../src/services/slash-discovery/resolve-overrides.ts";
import type { SlashItemWithSource, SkillRoot } from "../../../../src/services/slash-discovery/types.ts";

describe("resolveOverrides", () => {
  const createItem = (
    type: string,
    name: string,
    source: any,
    rootPath = "/root",
    filePath = "/root/SKILL.md",
  ): SlashItemWithSource => ({
    type: type as any,
    name,
    description: `Description for ${name}`,
    scope: "user",
    source,
    rootPath,
    filePath,
  });

  const createRoot = (path: string, source: any): SkillRoot => ({
    path,
    source,
    origin: "skills",
  });

  it("returns single item as active when no conflicts", () => {
    const items = [createItem("skill", "deploy", "bundled")];
    const roots = [createRoot("/bundled", "bundled")];

    const result = resolveOverrides(items, roots);

    expect(result.active).toHaveLength(1);
    expect(result.active[0]!.name).toBe("deploy");
    expect(result.shadowed).toHaveLength(0);
  });

  it("shadows lower-priority item when two have same type:name", () => {
    const items = [
      createItem("skill", "review", "project-ppm"),
      createItem("skill", "review", "user-claude"),
    ];
    const roots = [
      createRoot("/proj/.ppm", "project-ppm"),
      createRoot("~/.claude", "user-claude"),
    ];

    const result = resolveOverrides(items, roots);

    expect(result.active).toHaveLength(1);
    expect(result.active[0]!.source).toBe("project-ppm");
    expect(result.shadowed).toHaveLength(1);
    expect(result.shadowed[0]!.source).toBe("user-claude");
    expect(result.shadowed[0]!.shadowedBy.source).toBe("project-ppm");
  });

  it("keeps items with different names both active", () => {
    const items = [
      createItem("skill", "review", "project-ppm"),
      createItem("skill", "deploy", "user-claude"),
    ];
    const roots = [
      createRoot("/proj/.ppm", "project-ppm"),
      createRoot("~/.claude", "user-claude"),
    ];

    const result = resolveOverrides(items, roots);

    expect(result.active).toHaveLength(2);
    expect(result.shadowed).toHaveLength(0);
    expect(result.active.map((i) => i.name)).toContain("review");
    expect(result.active.map((i) => i.name)).toContain("deploy");
  });

  it("keeps items with different types both active even with same name", () => {
    const items = [
      createItem("skill", "test", "project-ppm"),
      createItem("command", "test", "user-claude"),
    ];
    const roots = [
      createRoot("/proj/.ppm", "project-ppm"),
      createRoot("~/.claude", "user-claude"),
    ];

    const result = resolveOverrides(items, roots);

    expect(result.active).toHaveLength(2);
    expect(result.shadowed).toHaveLength(0);
  });

  it("handles three-way conflict, highest priority wins", () => {
    const items = [
      createItem("skill", "deploy", "bundled"),
      createItem("skill", "deploy", "user-claude"),
      createItem("skill", "deploy", "project-ppm"),
    ];
    const roots = [
      createRoot("/bundled", "bundled"),
      createRoot("~/.claude", "user-claude"),
      createRoot("/proj/.ppm", "project-ppm"),
    ];

    const result = resolveOverrides(items, roots);

    expect(result.active).toHaveLength(1);
    expect(result.active[0]!.source).toBe("project-ppm");
    expect(result.shadowed).toHaveLength(2);
    expect(result.shadowed.map((s) => s.source)).toContain("user-claude");
    expect(result.shadowed.map((s) => s.source)).toContain("bundled");
  });

  it("sets shadowedBy metadata correctly on shadowed items", () => {
    const items = [
      createItem("skill", "review", "project-ppm"),
      createItem("skill", "review", "user-claude"),
    ];
    const roots = [
      createRoot("/proj/.ppm", "project-ppm"),
      createRoot("~/.claude", "user-claude"),
    ];

    const result = resolveOverrides(items, roots);
    const shadowed = result.shadowed[0]!;

    expect(shadowed.shadowedBy.name).toBe("review");
    expect(shadowed.shadowedBy.source).toBe("project-ppm");
  });

  it("prioritizes sources according to SOURCE_PRIORITY", () => {
    // SOURCE_PRIORITY: project-ppm (0) < user-claw (6) < bundled (9)
    const items = [
      createItem("skill", "skill1", "bundled"),
      createItem("skill", "skill1", "user-claw"),
      createItem("skill", "skill1", "project-ppm"),
    ];
    const roots = [
      createRoot("/bundled", "bundled"),
      createRoot("~/.claw", "user-claw"),
      createRoot("/proj/.ppm", "project-ppm"),
    ];

    const result = resolveOverrides(items, roots);

    expect(result.active[0]!.source).toBe("project-ppm");
    expect(result.shadowed.map((s) => s.source).sort()).toEqual(["bundled", "user-claw"]);
  });

  it("preserves root metadata in result", () => {
    const items = [createItem("skill", "test", "project-ppm")];
    const roots = [
      createRoot("/proj/.ppm", "project-ppm"),
      createRoot("~/.claude", "user-claude"),
    ];

    const result = resolveOverrides(items, roots);

    expect(result.roots).toEqual(roots);
  });

  it("handles empty items array", () => {
    const result = resolveOverrides([], []);

    expect(result.active).toHaveLength(0);
    expect(result.shadowed).toHaveLength(0);
    expect(result.roots).toHaveLength(0);
  });

  it("handles multiple non-conflicting items from same source", () => {
    const items = [
      createItem("skill", "deploy", "project-ppm"),
      createItem("skill", "review", "project-ppm"),
      createItem("command", "config", "project-ppm"),
    ];
    const roots = [createRoot("/proj/.ppm", "project-ppm")];

    const result = resolveOverrides(items, roots);

    expect(result.active).toHaveLength(3);
    expect(result.shadowed).toHaveLength(0);
  });
});
