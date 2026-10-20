/**
 * A session's change list kept between asks: an ask works out again only the files whose stamp
 * moved, whoever moved them, and the agent's own writes are worked out as they land and pushed.
 * Before, every ask worked out every file — minutes on a session that touched thousands.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { recordBaseline } from "../../../src/services/session-file-baselines/session-file-baselines.service.ts";
import { _resetSessionFileHistory, observeFile } from "../../../src/services/session-file-baselines/session-file-history.ts";
import { _resetSessionFileBlame } from "../../../src/services/session-file-baselines/session-file-blame.ts";
import {
  _resetSessionFileChanges,
  _sessionFilesWorkedOut,
  onSessionFileChanges,
  sessionFileChanges,
  setSessionFilesReviewed,
  type SessionFileChangesPush,
} from "../../../src/services/session-file-baselines/session-file-changes.service.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
const SESSION = "5b0e7c3a-2d4f-4e6a-9b1c-8d7e6f5a4b3c";
let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "ppm-kept-list-home-"));
  project = mkdtempSync(resolve(tmpdir(), "ppm-kept-list-project-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
  setDb(openTestDb());
  _resetSessionFileChanges();
  _resetSessionFileHistory();
  _resetSessionFileBlame();
});

afterEach(() => {
  _resetSessionFileChanges();
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  rmRetrying(home);
  rmRetrying(project);
});

const file = (name: string) => join(project, name);
const list = (paths?: string[]) => sessionFileChanges({ sessionId: SESSION, projectPath: project, paths });

/** A file the session changed: its "before" kept, the disk holding `now`. */
function changed(name: string, before: string, now: string): string {
  recordBaseline(SESSION, file(name), before);
  writeFileSync(file(name), now);
  return file(name);
}

function git(...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: project });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

async function waitFor(done: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) await Bun.sleep(10);
}

describe("a kept list", () => {
  it("works out again only the files that moved since the last ask", async () => {
    changed("a.ts", "a\n", "a2\n");
    const b = changed("b.ts", "b\n", "b2\n");
    changed("c.ts", "c\n", "c2\n");
    const from = _sessionFilesWorkedOut();
    expect(await list()).toHaveLength(3);
    expect(_sessionFilesWorkedOut() - from).toBe(3);

    await list();
    expect(_sessionFilesWorkedOut() - from).toBe(3);

    // An edit made outside the agent, which no push announces: the next ask still sees it.
    writeFileSync(b, "b2\nand more\n");
    const after = await list();
    expect(_sessionFilesWorkedOut() - from).toBe(4);
    expect(after.find((f) => f.path === b)?.additions).toBe(2);
  });

  it("works a file out again once it is marked reviewed", async () => {
    const a = changed("a.ts", "one\n", "two\n");
    const [row] = await list();
    await setSessionFilesReviewed({ sessionId: SESSION, projectPath: project, files: [{ path: a, version: row!.version }], reviewed: true });
    expect((await list()).map((f) => [f.path, f.reviewed])).toEqual([[a, true]]);
  });

  it("shows a mark saved while a list was being worked out, to an ask made after it", async () => {
    // Enough files that the first list is still being worked out when the mark is saved.
    for (let i = 0; i < 300; i++) changed(`f${String(i).padStart(3, "0")}.ts`, "export const v = 0;\n".repeat(40), "export const v = 1;\n".repeat(40));
    const first = file("f000.ts");
    const st = statSync(first);
    const from = _sessionFilesWorkedOut();
    const running = list();
    // Marked once the list is past that file, as the browser does while a refresh is on its way.
    await waitFor(() => _sessionFilesWorkedOut() - from >= 1);
    const marked = await setSessionFilesReviewed({ sessionId: SESSION, projectPath: project, files: [{ path: first, version: `${st.size}:${st.mtimeMs}` }], reviewed: true });
    expect(marked.updated).toEqual([first]);
    const asked = await list();
    await running;
    expect(asked.find((f) => f.path === first)?.reviewed).toBe(true);
  });

  it("works a file with no 'before' out again once HEAD moves", async () => {
    git("init", "-q");
    writeFileSync(file("x.ts"), "one\n");
    git("add", "x.ts");
    git("commit", "-q", "-m", "one");
    writeFileSync(file("x.ts"), "two\n");
    expect((await list(["x.ts"])).map((f) => [f.path, f.baseline])).toEqual([[file("x.ts"), "head"]]);
    // Committed elsewhere: the file is as HEAD has it, and no stamp of the file itself moved.
    git("commit", "-q", "-am", "two");
    expect(await list(["x.ts"])).toEqual([]);
  });

  it("lists the newest files once a session is past the cap", async () => {
    for (let i = 0; i < 501; i++) changed(`f${String(i).padStart(3, "0")}.ts`, `a${i}\n`, `b${i}\n`);
    const listed = (await list()).map((f) => f.path);
    expect(listed).toHaveLength(500);
    expect(listed).toContain(file("f500.ts"));
    expect(listed).not.toContain(file("f000.ts"));
  });
});

describe("pushing what the agent changed", () => {
  let pushes: SessionFileChangesPush[] = [];
  let off: () => void = () => {};
  beforeEach(() => {
    pushes = [];
    off = onSessionFileChanges((p) => pushes.push(p));
  });
  afterEach(() => off());

  /** One of the agent's edits: the call's "before" and "after" go into the session's history. */
  async function agentWrites(path: string, call: string, text: string) {
    await observeFile(SESSION, path, call, "before");
    writeFileSync(path, text);
    await observeFile(SESSION, path, call, "after");
  }

  it("pushes the row of a file the agent just changed, naming the call", async () => {
    const a = changed("a.ts", "one\n", "one\n");
    expect(await list()).toEqual([]);
    await agentWrites(a, "toolu_1", "one\ntwo\n");
    await waitFor(() => pushes.length > 0);
    expect(pushes.map((p) => ({ session: p.sessionId, files: p.files.map((f) => [f.path, f.blocks?.map((b) => b.calls)]), gone: p.gone }))).toEqual([
      { session: SESSION, files: [[a, [["toolu_1"]]]], gone: [] },
    ]);
  });

  it("says a file is gone from the list once the agent puts it back", async () => {
    const a = changed("a.ts", "one\n", "one\ntwo\n");
    expect(await list()).toHaveLength(1);
    await agentWrites(a, "toolu_2", "one\n");
    await waitFor(() => pushes.length > 0);
    expect(pushes.map((p) => [p.files, p.gone])).toEqual([[[], [a]]]);
  });

  it("pushes a rewrite the file's own stamp cannot tell apart", async () => {
    // Same size, and within one tick of a coarse file clock: only the history says it moved.
    const a = changed("a.ts", "one\n", "one\n");
    const tick = new Date(1_700_000_000_000);
    utimesSync(a, tick, tick);
    expect(await list()).toEqual([]);
    await agentWrites(a, "toolu_4", "two\n");
    utimesSync(a, tick, tick);
    await waitFor(() => pushes.length > 0);
    expect(pushes.flatMap((p) => p.files.map((f) => [f.path, f.blocks?.map((b) => b.calls)]))).toEqual([[a, [["toolu_4"]]]]);
  });

  it("pushes nothing for a session whose list nobody asked for", async () => {
    const a = changed("a.ts", "one\n", "one\n");
    await agentWrites(a, "toolu_3", "one\ntwo\n");
    await Bun.sleep(400);
    expect(pushes).toEqual([]);
  });
});
