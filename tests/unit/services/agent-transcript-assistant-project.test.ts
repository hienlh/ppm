/**
 * Agent cards inside a PPM Assistant chat stream like any other: the Assistant's virtual
 * project names its work directory, and ownership is proven against that directory — so an
 * Assistant session is not readable under a real project's name, nor the reverse.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { assertSessionInProject } from "../../../src/services/agent-transcript/session-ownership.ts";
import { projectPathFor } from "../../../src/services/agent-transcript/agent-transcript-hub-registry.ts";
import { assistantWorkDir } from "../../../src/services/assistant/assistant-work-dir.ts";
import { ASSISTANT_PROJECT_NAME } from "../../../src/shared/assistant-project.ts";

const ASSISTANT_SESSION = "aaaaaaaa-0000-4000-8000-000000000001";
const PROJECT_SESSION = "bbbbbbbb-0000-4000-8000-000000000002";
const PROJECT_PATH = join(tmpdir(), "ppm-agent-transcript-real-project");
const slug = (p: string) => p.replace(/[/\\:.]/g, "-");

let claudeRoot: string;
let savedProjects: unknown;

beforeEach(() => {
  claudeRoot = mkdtempSync(join(tmpdir(), "ppm-claude-root-"));
  _setClaudeProjectsRoot(claudeRoot);
  for (const [dir, id] of [[assistantWorkDir(), ASSISTANT_SESSION], [PROJECT_PATH, PROJECT_SESSION]] as const) {
    mkdirSync(join(claudeRoot, slug(dir)), { recursive: true });
    writeFileSync(join(claudeRoot, slug(dir), `${id}.jsonl`), "{}\n");
  }
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "real", path: PROJECT_PATH }]);
});

afterEach(() => {
  _setClaudeProjectsRoot(null);
  configService.set("projects", savedProjects as never);
  rmSync(claudeRoot, { recursive: true, force: true });
});

describe("Agent transcripts in the Assistant's virtual project", () => {
  it("resolves the virtual project to the Assistant work dir, and nothing else to it", () => {
    expect(projectPathFor(ASSISTANT_PROJECT_NAME)).toBe(assistantWorkDir());
    expect(projectPathFor("real")).toBe(PROJECT_PATH);
    expect(projectPathFor("unknown")).toBeNull();
  });

  it("owns an Assistant session under the virtual project only", () => {
    const owned = assertSessionInProject({ providerId: "claude", sessionId: ASSISTANT_SESSION, projectPath: projectPathFor(ASSISTANT_PROJECT_NAME)! });
    expect(owned).toMatchObject({ ok: true, projectPath: assistantWorkDir() });
    expect(assertSessionInProject({ providerId: "claude", sessionId: ASSISTANT_SESSION, projectPath: projectPathFor("real")! }))
      .toEqual({ ok: false, code: "session_not_found" });
  });

  it("does not hand a real project's session to the virtual project", () => {
    expect(assertSessionInProject({ providerId: "claude", sessionId: PROJECT_SESSION, projectPath: projectPathFor("real")! }))
      .toMatchObject({ ok: true });
    expect(assertSessionInProject({ providerId: "claude", sessionId: PROJECT_SESSION, projectPath: projectPathFor(ASSISTANT_PROJECT_NAME)! }))
      .toEqual({ ok: false, code: "session_not_found" });
  });
});
