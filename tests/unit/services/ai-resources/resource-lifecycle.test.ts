import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  listAiResources, createResource, readResource, writeResource,
  duplicateResource, deleteResource,
} from "../../../../src/services/ai-resources/index.ts";

let proj: string;

beforeEach(() => {
  proj = mkdtempSync(resolve(tmpdir(), "ppm-airsrc-"));
  // A pre-existing agent so agent discovery is exercised.
  const agentsDir = resolve(proj, ".claude/agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    resolve(agentsDir, "planner.md"),
    "---\nname: planner\ndescription: Plans work\nmodel: opus\ntools: Read, Grep\n---\n\nPlan it.\n",
  );
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

describe("ai-resources lifecycle", () => {
  it("discovers agents with parsed model + tools", () => {
    const { groups } = listAiResources(proj);
    const agents = groups.find((g) => g.type === "agent");
    const planner = agents?.items.find((i) => i.name === "planner");
    expect(planner).toBeTruthy();
    expect(planner!.model).toBe("opus");
    expect(planner!.tools).toEqual(["Read", "Grep"]);
    expect(planner!.scope).toBe("project");
  });

  it("creates a skill as a dir-based SKILL.md", () => {
    const fp = createResource("skill", "project", "deploy", proj);
    expect(fp.replace(/\\/g, "/")).toContain(".claude/skills/deploy/SKILL.md");
    expect(existsSync(fp)).toBe(true);
    const { groups } = listAiResources(proj);
    const skill = groups.find((g) => g.type === "skill")?.items.find((i) => i.name === "deploy");
    expect(skill).toBeTruthy();
  });

  it("rejects duplicate create in same scope", () => {
    createResource("command", "project", "ship", proj);
    expect(() => createResource("command", "project", "ship", proj)).toThrow();
  });

  it("reads and writes content", () => {
    const fp = createResource("agent", "project", "writer", proj);
    writeResource(fp, "---\nname: writer\ndescription: updated\n---\nBody\n", proj);
    expect(readResource(fp, proj)).toContain("description: updated");
  });

  it("duplicates a resource under a new name", () => {
    const src = resolve(proj, ".claude/agents/planner.md");
    const dup = duplicateResource(src, "agent", "project", "planner-copy", proj);
    expect(existsSync(dup)).toBe(true);
    expect(readResource(dup, proj)).toContain("name: planner-copy");
  });

  it("deletes a skill folder wholesale", () => {
    const fp = createResource("skill", "project", "temp", proj);
    deleteResource(fp, "skill", proj);
    expect(existsSync(resolve(proj, ".claude/skills/temp"))).toBe(false);
  });

  it("rejects reads outside managed roots", () => {
    expect(() => readResource(resolve(proj, "../../etc/passwd"), proj)).toThrow();
  });
});
