import { describe, it, expect } from "bun:test";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { resolveTargetDir } from "../../../src/services/skill-export/resolve-target-dir.ts";

describe("resolveTargetDir", () => {
  it("user scope → ~/.claude/skills/ppm", () => {
    const r = resolveTargetDir({ scope: "user" });
    expect(r).toBe(resolve(homedir(), ".claude/skills/ppm"));
  });

  it("project scope → <cwd>/.claude/skills/ppm", () => {
    const r = resolveTargetDir({ scope: "project" });
    expect(r).toBe(resolve(process.cwd(), ".claude/skills/ppm"));
  });

  it("output flag overrides scope", () => {
    const r = resolveTargetDir({ scope: "user", output: "/tmp/custom" });
    expect(r).toBe("/tmp/custom");
  });

  it("default (no scope) uses user scope", () => {
    const r = resolveTargetDir({});
    expect(r).toEndWith(".claude/skills/ppm");
  });

  it("relative output is resolved to absolute", () => {
    const r = resolveTargetDir({ output: "./rel/path" });
    expect(r).toBe(resolve("./rel/path"));
  });

  it("codex format with user scope → ~/.agents/skills/ppm", () => {
    const r = resolveTargetDir({ format: "codex", scope: "user" });
    expect(r).toBe(resolve(homedir(), ".agents/skills/ppm"));
  });

  it("codex format with project scope → <cwd>/.agents/skills/ppm", () => {
    const r = resolveTargetDir({ format: "codex", scope: "project" });
    expect(r).toBe(resolve(process.cwd(), ".agents/skills/ppm"));
  });

  it("antigravity format with user scope → ~/.gemini/config/skills/ppm", () => {
    const r = resolveTargetDir({ format: "antigravity", scope: "user" });
    expect(r).toBe(resolve(homedir(), ".gemini/config/skills/ppm"));
  });

  it("antigravity format with project scope → <cwd>/.agents/skills/ppm", () => {
    const r = resolveTargetDir({ format: "antigravity", scope: "project" });
    expect(r).toBe(resolve(process.cwd(), ".agents/skills/ppm"));
  });
});
