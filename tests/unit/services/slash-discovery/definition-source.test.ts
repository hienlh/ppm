import { describe, it, expect } from "bun:test";
import {
  compareSourcePriority,
  sourceToScope,
  SOURCE_PRIORITY,
} from "../../../../src/services/slash-discovery/definition-source.ts";
import type { DefinitionSource } from "../../../../src/services/slash-discovery/types.ts";

describe("SOURCE_PRIORITY", () => {
  it("defines priority for all known sources", () => {
    const sources: DefinitionSource[] = [
      "project-ppm",
      "project-claw",
      "project-codex",
      "project-claude",
      "env-var",
      "user-ppm",
      "user-claw",
      "user-codex",
      "user-claude",
      "bundled",
    ];

    for (const source of sources) {
      expect(SOURCE_PRIORITY[source]).toBeDefined();
      expect(typeof SOURCE_PRIORITY[source]).toBe("number");
    }
  });

  it("has project-ppm with highest priority (0)", () => {
    expect(SOURCE_PRIORITY["project-ppm"]).toBe(0);
  });

  it("has bundled with lowest priority (9)", () => {
    expect(SOURCE_PRIORITY["bundled"]).toBe(9);
  });

  it("priorities are sequential from 0 to 9", () => {
    const priorities = Object.values(SOURCE_PRIORITY).sort((a, b) => a - b);
    const expected = Array.from({ length: 10 }, (_, i) => i);

    expect(priorities).toEqual(expected);
  });

  it("enforces project sources (0-3) > env-var (4) > user sources (5-8) > bundled (9)", () => {
    const projectMax = Math.max(
      SOURCE_PRIORITY["project-ppm"],
      SOURCE_PRIORITY["project-claw"],
      SOURCE_PRIORITY["project-codex"],
      SOURCE_PRIORITY["project-claude"],
    );
    const userMin = Math.min(
      SOURCE_PRIORITY["user-ppm"],
      SOURCE_PRIORITY["user-claw"],
      SOURCE_PRIORITY["user-codex"],
      SOURCE_PRIORITY["user-claude"],
    );

    expect(projectMax).toBeLessThan(SOURCE_PRIORITY["env-var"]);
    expect(SOURCE_PRIORITY["env-var"]).toBeLessThan(userMin);
    expect(userMin).toBeLessThan(SOURCE_PRIORITY["bundled"]);
  });
});

describe("compareSourcePriority", () => {
  it("returns negative when first source has higher priority", () => {
    const result = compareSourcePriority("project-ppm", "bundled");
    expect(result).toBeLessThan(0);
  });

  it("returns positive when first source has lower priority", () => {
    const result = compareSourcePriority("bundled", "project-ppm");
    expect(result).toBeGreaterThan(0);
  });

  it("returns 0 when sources are the same", () => {
    const result = compareSourcePriority("user-claude", "user-claude");
    expect(result).toBe(0);
  });

  it("correctly orders project sources highest", () => {
    const projectSources: DefinitionSource[] = [
      "project-ppm",
      "project-claw",
      "project-codex",
      "project-claude",
    ];

    // All project sources should be negative compared to bundled
    for (const source of projectSources) {
      expect(compareSourcePriority(source, "bundled")).toBeLessThan(0);
    }
  });

  it("correctly orders user sources above bundled", () => {
    const userSources: DefinitionSource[] = [
      "user-ppm",
      "user-claw",
      "user-codex",
      "user-claude",
    ];

    // All user sources should be negative compared to bundled
    for (const source of userSources) {
      expect(compareSourcePriority(source, "bundled")).toBeLessThan(0);
    }
  });

  it("correctly orders env-var between project and user", () => {
    expect(compareSourcePriority("project-ppm", "env-var")).toBeLessThan(0);
    expect(compareSourcePriority("env-var", "user-claude")).toBeLessThan(0);
  });

  it("can be used to sort sources by priority", () => {
    const sources: DefinitionSource[] = [
      "bundled",
      "user-claude",
      "project-ppm",
      "env-var",
    ];

    const sorted = [...sources].sort(compareSourcePriority);

    expect(sorted[0]).toBe("project-ppm");
    expect(sorted[1]).toBe("env-var");
    expect(sorted[2]).toBe("user-claude");
    expect(sorted[3]).toBe("bundled");
  });

  it("sorts multiple project sources correctly", () => {
    const sources: DefinitionSource[] = [
      "project-claude",
      "project-ppm",
      "project-claw",
      "project-codex",
    ];

    const sorted = [...sources].sort(compareSourcePriority);

    expect(sorted[0]).toBe("project-ppm");
    expect(sorted[1]).toBe("project-claw");
    expect(sorted[2]).toBe("project-codex");
    expect(sorted[3]).toBe("project-claude");
  });

  it("sorts multiple user sources correctly", () => {
    const sources: DefinitionSource[] = [
      "user-claude",
      "user-ppm",
      "user-claw",
      "user-codex",
    ];

    const sorted = [...sources].sort(compareSourcePriority);

    expect(sorted[0]).toBe("user-ppm");
    expect(sorted[1]).toBe("user-claw");
    expect(sorted[2]).toBe("user-codex");
    expect(sorted[3]).toBe("user-claude");
  });
});

describe("sourceToScope", () => {
  it("maps bundled source to bundled scope", () => {
    expect(sourceToScope("bundled")).toBe("bundled");
  });

  it("maps all project sources to project scope", () => {
    const projectSources: DefinitionSource[] = [
      "project-ppm",
      "project-claw",
      "project-codex",
      "project-claude",
    ];

    for (const source of projectSources) {
      expect(sourceToScope(source)).toBe("project");
    }
  });

  it("maps env-var to project scope", () => {
    expect(sourceToScope("env-var")).toBe("project");
  });

  it("maps all user sources to user scope", () => {
    const userSources: DefinitionSource[] = [
      "user-ppm",
      "user-claw",
      "user-codex",
      "user-claude",
    ];

    for (const source of userSources) {
      expect(sourceToScope(source)).toBe("user");
    }
  });

  it("handles all known sources", () => {
    const allSources: DefinitionSource[] = [
      "project-ppm",
      "project-claw",
      "project-codex",
      "project-claude",
      "env-var",
      "user-ppm",
      "user-claw",
      "user-codex",
      "user-claude",
      "bundled",
    ];

    const validScopes = ["project", "user", "bundled"];

    for (const source of allSources) {
      const scope = sourceToScope(source);
      expect(validScopes).toContain(scope);
    }
  });

  it("returns consistent scope for multiple calls", () => {
    const source: DefinitionSource = "user-claude";

    expect(sourceToScope(source)).toBe(sourceToScope(source));
  });

  it("distinguishes between project and user scopes", () => {
    const projectScope = sourceToScope("project-ppm");
    const userScope = sourceToScope("user-ppm");

    expect(projectScope).not.toBe(userScope);
    expect(projectScope).toBe("project");
    expect(userScope).toBe("user");
  });
});
