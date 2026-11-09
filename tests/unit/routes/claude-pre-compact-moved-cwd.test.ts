import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { chatRoutes } from "../../../src/server/routes/chat.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

// Claude Code names the transcript in a compact summary after the folder the session was started
// or resumed in. A session resumed in a subdirectory names a project folder that does not exist,
// while its transcript stays in the folder of the project the session started in.

const PROJECT = "/workspace/app";
const OTHER_PROJECT = "/workspace/other";
const SESSION_ID = "00000000-0000-4000-8000-0000000000c1";

/** Claude Code's folder name for a project path. */
const slugOf = (path: string) => path.replace(/[/\\:.]/g, "-");

let home: string;
let claudeRoot: string;
let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">>;

beforeEach(() => {
  // `validateJsonlPath` jails a transcript to `<homedir()>/.claude`, and Bun caches `homedir()`, so
  // moving HOME does nothing. Spying on it moves the jail into a scratch home instead, and nothing
  // here touches the user's real `~/.claude`. Realpath'd because the jail compares the file's
  // realpath, and macOS's tmpdir sits behind a symlink into /private.
  home = realpathSync(mkdtempSync(join(os.tmpdir(), "ppm-pre-compact-home-")));
  homedirSpy = spyOn(os, "homedir").mockReturnValue(home);
  claudeRoot = join(home, ".claude", "projects");
  _setClaudeProjectsRoot(claudeRoot);
});

afterEach(async () => {
  _setClaudeProjectsRoot(null);
  homedirSpy.mockRestore();
  await rmRetrying(home);
});

function writeTranscript(projectPath: string, before = "before compaction"): void {
  const dir = join(claudeRoot, slugOf(projectPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SESSION_ID}.jsonl`), [
    { uuid: "pre1", type: "user", message: { content: before } },
    { uuid: "compact", type: "user", isCompactSummary: true, message: { content: "summary" } },
    { uuid: "post1", type: "assistant", message: { content: [{ type: "text", text: "after compaction" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}

/** The path a summary written from `cwd` names for this session. */
function namedFrom(cwd: string): string {
  return join(claudeRoot, slugOf(cwd), `${SESSION_ID}.jsonl`);
}

function requestPreCompact(jsonlPath: string, projectPath = PROJECT) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("projectPath" as never, projectPath as never); await next(); });
  app.route("/chat", chatRoutes);
  return app.request(`/chat/pre-compact-messages?jsonlPath=${encodeURIComponent(jsonlPath)}&before=compact`);
}

test("a summary written by a session resumed in a subdirectory still loads the history before it", async () => {
  writeTranscript(PROJECT);
  const res = await requestPreCompact(namedFrom(`${PROJECT}/tools/.runtime/checkout`));
  expect(res.status).toBe(200);
  expect((await res.json() as any).data.map((m: any) => m.sdkUuid)).toEqual(["pre1"]);
});

test("when the named file is missing, the session's file in another project's folder is not served", async () => {
  writeTranscript(OTHER_PROJECT, "history of the other project");
  const named = namedFrom(`${OTHER_PROJECT}/tools`);
  // The project that file belongs to gets it through the same fallback, so the 404 below is the
  // project check refusing it, not a file the route could never have found.
  const own = await requestPreCompact(named, OTHER_PROJECT);
  expect(await own.text()).toContain("history of the other project");
  const res = await requestPreCompact(named);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("history of the other project");
});
