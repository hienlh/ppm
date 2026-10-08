import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";

// Claude Code names the transcript in a compact summary after the cwd the session had when it
// compacted. A session that had `cd`'d into a subdirectory names a project folder that does not
// exist, while its transcript stays in the folder of the project the session started in.

const PROJECT = "/workspace/app";
const OTHER_PROJECT = "/workspace/other";
const SESSION_ID = "00000000-0000-4000-8000-0000000000c1";

/** Claude Code's folder name for a project path. */
const slugOf = (path: string) => path.replace(/[/\\:.]/g, "-");

let claudeRoot: string;

beforeEach(() => {
  // `validateJsonlPath` jails a transcript to the real `~/.claude`, and Bun caches `homedir()`,
  // so HOME cannot be moved: the scratch projects root has to sit inside it.
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  claudeRoot = mkdtempSync(join(homedir(), ".claude", "ppm-test-projects-"));
  _setClaudeProjectsRoot(claudeRoot);
});

afterEach(() => {
  _setClaudeProjectsRoot(null);
  rmSync(claudeRoot, { recursive: true, force: true });
});

function writeTranscript(projectPath: string): void {
  const dir = join(claudeRoot, slugOf(projectPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION_ID}.jsonl`), [
    { uuid: "pre1", type: "user", message: { content: "before compaction" } },
    { uuid: "compact", type: "user", isCompactSummary: true, message: { content: "summary" } },
    { uuid: "post1", type: "assistant", message: { content: [{ type: "text", text: "after compaction" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}

/** The path a summary written from `cwd` names for this session. */
function namedFrom(cwd: string): string {
  return join(claudeRoot, slugOf(cwd), `${SESSION_ID}.jsonl`);
}

function requestPreCompact(jsonlPath: string) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("projectPath" as never, PROJECT as never); await next(); });
  app.route("/chat", chatRoutes);
  return app.request(`/chat/pre-compact-messages?jsonlPath=${encodeURIComponent(jsonlPath)}&before=compact`);
}

test("a summary written after a cd into a subdirectory still loads the history before it", async () => {
  writeTranscript(PROJECT);
  const res = await requestPreCompact(namedFrom(`${PROJECT}/tools/.runtime/checkout`));
  expect(res.status).toBe(200);
  expect((await res.json() as any).data.map((m: any) => m.sdkUuid)).toEqual(["pre1"]);
});

test("the session's file is looked for in the requesting project's folder only", async () => {
  writeTranscript(OTHER_PROJECT);
  const res = await requestPreCompact(namedFrom(`${PROJECT}/tools`));
  expect(res.status).toBe(404);
});
