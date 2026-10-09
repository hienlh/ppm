/**
 * The Assistant's tools name a registered project, and a session only when it is proven to be a
 * chat of that project. The Assistant's own virtual project and its own sessions are never a
 * target, and an unknown project name is refused rather than guessed.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { setSessionAssistant, setSessionMetadata, setSessionMigratedTo, setSessionProvider } from "../../../src/services/db.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import {
  resolveAssistantProject, resolveAssistantSessionTarget,
} from "../../../src/services/assistant-mcp/assistant-project-scope.ts";
import { chatReadMessages } from "../../../src/services/assistant-mcp/assistant-read-tools.ts";

let root: string;
let claudeRoot: string;
let saved: unknown;
const projectA = () => ({ name: "alpha", path: join(root, "alpha") });
const projectB = () => ({ name: "beta", path: join(root, "beta") });
const slug = (p: string) => p.replace(/[/\\:.]/g, "-");

function claudeSession(projectPath: string): string {
  const id = crypto.randomUUID();
  const dir = join(claudeRoot, slug(projectPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), '{"type":"user"}\n');
  return id;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-asst-scope-"));
  claudeRoot = join(root, "claude-projects");
  mkdirSync(projectA().path, { recursive: true });
  mkdirSync(projectB().path, { recursive: true });
  _setClaudeProjectsRoot(claudeRoot);
  saved = configService.get("projects");
  configService.set("projects", [projectA(), projectB()]);
});
afterAll(() => {
  configService.set("projects", saved as never);
  _setClaudeProjectsRoot(null);
  rmSync(root, { recursive: true, force: true });
});

describe("resolveAssistantProject", () => {
  it("resolves a registered project by its exact name", () => {
    expect(resolveAssistantProject("alpha")).toEqual({ ok: true, value: projectA() });
  });

  it("refuses the Assistant's own project, an unknown name and a missing one", () => {
    for (const name of ["__assistant__", "gamma", "ALPHA", "", undefined, 3]) {
      const result = resolveAssistantProject(name);
      expect(result.ok).toBe(false);
    }
    expect(resolveAssistantProject("__assistant__")).toEqual({ ok: false, error: expect.stringContaining("not a project") });
  });
});

describe("resolveAssistantSessionTarget", () => {
  it("accepts a session of the project it names", () => {
    const id = claudeSession(projectA().path);
    expect(resolveAssistantSessionTarget(projectA(), id)).toEqual({ ok: true, value: { sessionId: id, providerId: "claude" } });
  });

  it("refuses a session that belongs to another project", async () => {
    const id = claudeSession(projectB().path);
    expect(resolveAssistantSessionTarget(projectA(), id)).toEqual({ ok: false, error: expect.stringContaining("not a chat of project \"alpha\"") });
    expect(resolveAssistantSessionTarget(projectA(), id, "claude").ok).toBe(false);
    // The tool says the same, before reading anything.
    const result = await chatReadMessages({ project: "alpha", sessionId: id });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("not a chat of project");
  });

  it("follows a renamed session to the id that owns the transcript", () => {
    const thread = claudeSession(projectA().path);
    const draft = crypto.randomUUID();
    setSessionMetadata(draft, "alpha", projectA().path);
    setSessionMigratedTo(draft, thread);
    setSessionProvider(thread, "claude");
    expect(resolveAssistantSessionTarget(projectA(), draft)).toEqual({ ok: true, value: { sessionId: thread, providerId: "claude" } });
  });

  it("refuses an Assistant session even when its transcript sits under the project", () => {
    const id = claudeSession(projectA().path);
    setSessionAssistant(id);
    expect(resolveAssistantSessionTarget(projectA(), id)).toEqual({ ok: false, error: expect.stringContaining("PPM Assistant chat") });
  });

  it("refuses malformed ids and providers", () => {
    expect(resolveAssistantSessionTarget(projectA(), "../../etc/passwd").ok).toBe(false);
    expect(resolveAssistantSessionTarget(projectA(), 42).ok).toBe(false);
    expect(resolveAssistantSessionTarget(projectA(), claudeSession(projectA().path), "cursor").ok).toBe(false);
  });
});
