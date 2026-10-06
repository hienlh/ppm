/**
 * The session review's server half: a session's "before" for each file against the file on
 * disk now, with git HEAD standing in for a file the session kept no copy of — inside the
 * project only, and never for a path the generic file routes would refuse.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chatFileChangesRoutes } from "../../../src/server/routes/chat-file-changes.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { openTestDb, setDb, setSessionMetadata } from "../../../src/services/db.service.ts";
import { recordBranch } from "../../../src/services/session-branch.service.ts";
import { recordBaseline } from "../../../src/services/session-file-baselines/session-file-baselines.service.ts";
import { versionOf } from "../../../src/services/session-file-baselines/session-review-actions.ts";
import { answerRecordFiles } from "../../../src/services/session-file-baselines/session-review-blocks.ts";
import { _resetSessionFileHistory, observeFile } from "../../../src/services/session-file-baselines/session-file-history.ts";

const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
const SESSION = "6f1d1c2e-9b7a-4e55-8a31-0c4b2d3e4f50";
/** A version branched from SESSION. */
const CHILD = "1e2d3c4b-0000-4a5b-8c7d-6e5f4a3b2c1d";
let home: string;
let project: string;
let app: Hono;

function git(...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: project });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "ppm-file-changes-home-"));
  project = mkdtempSync(resolve(tmpdir(), "ppm-file-changes-project-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
  setDb(openTestDb());
  // Both sessions are this project's, as the provider that starts a session records it.
  setSessionMetadata(SESSION, "proj", project);
  setSessionMetadata(CHILD, "proj", project);
  app = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
  app.use("*", async (c, next) => {
    c.set("projectPath" as never, project as never);
    await next();
  });
  app.route("/chat", chatFileChangesRoutes);
});

afterEach(() => {
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

async function changes(sessionId: string, paths?: string[]) {
  const res = await app.request(`http://x/chat/sessions/${sessionId}/file-changes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function diff(sessionId: string, path: string) {
  const res = await app.request(`http://x/chat/sessions/${sessionId}/file-changes/diff?path=${encodeURIComponent(path)}`);
  return { status: res.status, body: (await res.json()) as any };
}

async function review(sessionId: string, files: { path: string; version: string }[], reviewed = true) {
  const res = await app.request(`http://x/chat/sessions/${sessionId}/file-changes/reviewed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files, reviewed }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

type AnswerFile = { path: string; version: string; keys?: string[] };

async function answer(sessionId: string, kind: "keep" | "open" | "revert", files: AnswerFile[]) {
  const res = await app.request(`http://x/chat/sessions/${sessionId}/file-changes/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: kind, files }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function undo(sessionId: string, undoId: string) {
  const res = await app.request(`http://x/chat/sessions/${sessionId}/file-changes/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ undoId }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** `n` numbered lines. */
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");

/** `text` with its 1-based line `at` replaced. */
function replaceLine(text: string, at: number, by: string): string {
  return text.split("\n").map((line, i) => (i === at - 1 ? by : line)).join("\n");
}

const keptFlags = (file: any) => file.blocks.map((b: any) => !!b.kept);

/** A file's only change block, as the list summarises it. */
const oneBlock = { key: expect.any(String), added: expect.any(Number), removed: expect.any(Number) };
/** What the list says the blocks were cut against. */
const base = expect.stringMatching(/^[0-9a-f]{16}$/);

/** The one listed file at `path`, as the changes bar would get it. */
async function listed(sessionId: string, path: string) {
  return (await changes(sessionId)).body.data.files.find((f: any) => f.path === path);
}

describe("POST /chat/sessions/:id/file-changes", () => {
  it("compares each file the session kept a before for with the file on disk", async () => {
    const edited = join(project, "edited.ts");
    const created = join(project, "created.ts");
    const deleted = join(project, "deleted.ts");
    const reverted = join(project, "reverted.ts");
    recordBaseline(SESSION, edited, "a\nb\nc\n");
    recordBaseline(SESSION, created, null);
    recordBaseline(SESSION, deleted, "gone\nnow\n");
    recordBaseline(SESSION, reverted, "same\n");
    writeFileSync(edited, "a\nB\nc\nd\n");
    writeFileSync(created, "new\n");
    writeFileSync(reverted, "same\n");

    const { status, body } = await changes(SESSION);
    expect(status).toBe(200);
    expect(body.data.files).toEqual([
      { path: edited, status: "modified", baseline: "session", additions: 2, deletions: 1, version: expect.any(String), blocks: [oneBlock], base },
      { path: created, status: "added", baseline: "session", additions: 1, deletions: 0, version: expect.any(String), blocks: [oneBlock], base },
      { path: deleted, status: "deleted", baseline: "session", additions: 0, deletions: 2, version: expect.any(String), blocks: [oneBlock], base },
    ]);
  });

  it("falls back to git HEAD for a project file the session kept no copy of", async () => {
    git("init", "-q");
    writeFileSync(join(project, "tracked.ts"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(project, "tracked.ts"), "one\ntwo\n");
    writeFileSync(join(project, "untracked.ts"), "fresh\n");

    const { body } = await changes(SESSION, ["tracked.ts", join(project, "untracked.ts")]);
    expect(body.data.files).toEqual([
      { path: join(project, "tracked.ts"), status: "modified", baseline: "head", additions: 1, deletions: 0, version: expect.any(String), blocks: [oneBlock], base },
      { path: join(project, "untracked.ts"), status: "added", baseline: "head", additions: 1, deletions: 0, version: expect.any(String), blocks: [oneBlock], base },
    ]);
  });

  it("does not list a path outside the project that the session never touched", async () => {
    const outside = mkdtempSync(resolve(tmpdir(), "ppm-file-changes-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "x\n");
      expect((await changes(SESSION, [join(outside, "secret.txt")])).body.data.files).toEqual([]);
      // …but one it did change is listed, wherever it is.
      recordBaseline(SESSION, join(outside, "secret.txt"), "");
      expect((await changes(SESSION)).body.data.files.map((f: any) => f.path)).toEqual([join(outside, "secret.txt")]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never reads a file in the PPM directory, even from inside the project", async () => {
    // A project that contains the PPM directory, as a home-folder project does.
    process.env.PPM_HOME = join(project, ".ppm");
    _resetPpmDir();
    mkdirSync(join(project, ".ppm"), { recursive: true });
    writeFileSync(join(project, ".ppm", "ppm.db"), "credentials");
    git("init", "-q");
    expect((await changes(SESSION, [join(project, ".ppm", "ppm.db")])).body.data.files).toEqual([]);
    expect((await diff(SESSION, join(project, ".ppm", "ppm.db"))).status).toBe(403);
  });

  it("uses the parent's before for a version branched from it", async () => {
    const child = CHILD;
    recordBranch(child, SESSION, "m1", 1, "edit");
    recordBaseline(SESSION, join(project, "a.ts"), "parent saw this\n");
    writeFileSync(join(project, "a.ts"), "now\n");
    expect((await changes(child)).body.data.files).toEqual([
      { path: join(project, "a.ts"), status: "modified", baseline: "session", additions: 1, deletions: 1, version: expect.any(String), blocks: [oneBlock], base },
    ]);
  });

  it("refuses a session id that cannot name a directory", async () => {
    expect((await changes("not*valid")).status).toBe(400);
  });
});

describe("a session that is not this project's", () => {
  const OTHER = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d";
  let elsewhere: string;

  beforeEach(() => {
    elsewhere = mkdtempSync(resolve(tmpdir(), "ppm-file-changes-elsewhere-"));
  });
  afterEach(() => rmSync(elsewhere, { recursive: true, force: true }));

  async function post(sessionId: string, route: string, body: unknown) {
    const res = await app.request(`http://x/chat/sessions/${sessionId}/file-changes${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  }

  /** What each route answers for `sessionId` about `file`, at the version it is at. */
  async function everyRoute(sessionId: string, file: string): Promise<number[]> {
    const version = await versionOf(file);
    return [
      (await changes(sessionId)).status,
      (await diff(sessionId, file)).status,
      await post(sessionId, "/reviewed", { files: [{ path: file, version }], reviewed: true }),
      await post(sessionId, "/answer", { answer: "revert", files: [{ path: file, version }] }),
      await post(sessionId, "/undo", { undoId: "0123456789abcdef" }),
      await post(sessionId, "/revert-turn", { calls: ["toolu_1"] }),
    ];
  }

  it("is a 404 on every route when it was started in another project, and its files are left alone", async () => {
    setSessionMetadata(OTHER, "other", elsewhere);
    const file = join(elsewhere, "a.ts");
    recordBaseline(OTHER, file, "before\n");
    writeFileSync(file, "after\n");
    expect(await everyRoute(OTHER, file)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(readFileSync(file, "utf8")).toBe("after\n");
  });

  it("with no record, is a 404 on every route once PPM keeps a write of it", async () => {
    const file = join(elsewhere, "a.ts");
    recordBaseline(OTHER, file, "before\n");
    writeFileSync(file, "after\n");
    expect(await everyRoute(OTHER, file)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(readFileSync(file, "utf8")).toBe("after\n");
  });

  it("is this project's when its record says so, in a project whose path has an underscore and a space", async () => {
    const spaced = join(elsewhere, "my_project dir");
    mkdirSync(spaced);
    const spacedApp = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
    spacedApp.use("*", async (c, next) => {
      c.set("projectPath" as never, spaced as never);
      await next();
    });
    spacedApp.route("/chat", chatFileChangesRoutes);
    setSessionMetadata(OTHER, "my_project dir", spaced);
    const file = join(spaced, "a.ts");
    recordBaseline(OTHER, file, "before\n");
    writeFileSync(file, "after\n");

    const res = await spacedApp.request(`http://x/chat/sessions/${OTHER}/file-changes`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.files).toEqual([expect.objectContaining({ path: file, status: "modified" })]);
    // The same session through another project is not found.
    expect(await everyRoute(OTHER, file)).toEqual([404, 404, 404, 404, 404, 404]);
  });

  it("with no record and no write kept, reads only this project's files from git, as before", async () => {
    writeFileSync(join(project, "a.ts"), "committed\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(project, "a.ts"), "changed\n");
    expect((await changes(OTHER, [join(project, "a.ts")])).body.data.files).toEqual([
      expect.objectContaining({ path: join(project, "a.ts"), baseline: "head" }),
    ]);
  });
});

describe("GET /chat/sessions/:id/file-changes/diff", () => {
  it("hands back both sides of a file the session changed", async () => {
    recordBaseline(SESSION, join(project, "a.ts"), "before\n");
    writeFileSync(join(project, "a.ts"), "after\n");
    const { status, body } = await diff(SESSION, join(project, "a.ts"));
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ original: "before\n", modified: "after\n", status: "modified", baseline: "session" });
  });

  it("answers 404 for a file the session did not change", async () => {
    writeFileSync(join(project, "a.ts"), "x\n");
    expect((await diff(SESSION, join(project, "a.ts"))).status).toBe(404);
  });
});

describe("POST /chat/sessions/:id/file-changes/reviewed", () => {
  it("flags a file marked reviewed, then counts and diffs only what changed after the mark", async () => {
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "one\ntwo\n");
    const shown = await listed(SESSION, a);

    expect((await review(SESSION, [{ path: a, version: shown.version }])).body.data).toEqual({ updated: [a], stale: [] });
    // Still the whole session's change: that is what was reviewed, and what Show brings back.
    expect(await listed(SESSION, a)).toMatchObject({ reviewed: true, additions: 1, deletions: 0 });

    writeFileSync(a, "one\ntwo\nthree\n");
    const after = await listed(SESSION, a);
    expect(after).toMatchObject({ sinceReview: true, status: "modified", additions: 1, deletions: 0 });
    expect(after.reviewed).toBeUndefined();
    expect((await diff(SESSION, a)).body.data).toMatchObject({ original: "one\ntwo\n", modified: "one\ntwo\nthree\n", sinceReview: true });
  });

  it("leaves a file that moved on since it was shown, so a change nobody read is never hidden", async () => {
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    const shown = await listed(SESSION, a);
    writeFileSync(a, "three, written while the list was on screen\n");

    expect((await review(SESSION, [{ path: a, version: shown.version }])).body.data).toEqual({ updated: [], stale: [a] });
    const now = await listed(SESSION, a);
    expect(now.reviewed).toBeUndefined();
    expect(now.sinceReview).toBeUndefined();
  });

  it("keeps a file reviewed when it is written again unchanged", async () => {
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    await review(SESSION, [{ path: a, version: (await listed(SESSION, a)).version }]);
    writeFileSync(a, "two\n");
    utimesSync(a, new Date(), new Date(Date.now() + 60_000));
    expect(await listed(SESSION, a)).toMatchObject({ reviewed: true });
  });

  it("marks a deletion, and drops a file whose change was undone whatever its mark", async () => {
    const gone = join(project, "gone.ts");
    const back = join(project, "back.ts");
    recordBaseline(SESSION, gone, "x\n");
    recordBaseline(SESSION, back, "original\n");
    writeFileSync(back, "edited\n");
    const files = (await changes(SESSION)).body.data.files.map((f: any) => ({ path: f.path, version: f.version }));
    expect((await review(SESSION, files)).body.data.updated).toEqual([gone, back]);
    expect(await listed(SESSION, gone)).toMatchObject({ status: "deleted", reviewed: true });

    writeFileSync(back, "original\n");
    expect(await listed(SESSION, back)).toBeUndefined();
  });

  it("unmarks, and a version branched from the session keeps the parent's marks until it unmarks its own", async () => {
    const child = CHILD;
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    await review(SESSION, [{ path: a, version: (await listed(SESSION, a)).version }]);
    recordBranch(child, SESSION, "m1", 1, "edit");
    expect(await listed(child, a)).toMatchObject({ reviewed: true });

    expect((await review(child, [{ path: a, version: "" }], false)).body.data).toEqual({ updated: [a], stale: [] });
    expect((await listed(child, a)).reviewed).toBeUndefined();
    expect(await listed(SESSION, a)).toMatchObject({ reviewed: true });
    // Unmarking a file that has no mark changes nothing.
    expect((await review(child, [{ path: a, version: "" }], false)).body.data).toEqual({ updated: [], stale: [] });
  });

  it("marks nothing the session did not change, and copies nothing from the PPM directory", async () => {
    writeFileSync(join(project, "untouched.ts"), "x\n");
    process.env.PPM_HOME = join(project, ".ppm");
    _resetPpmDir();
    mkdirSync(join(project, ".ppm"), { recursive: true });
    writeFileSync(join(project, ".ppm", "ppm.db"), "credentials");
    // A repository with no commit: every file in it has an empty "before" at HEAD.
    git("init", "-q");

    const asked = [join(project, "untouched.ts"), join(project, ".ppm", "ppm.db")].map((path) => ({ path, version: "" }));
    expect((await review(SESSION, asked)).body.data).toEqual({ updated: [], stale: asked.map((f) => f.path) });
    expect(existsSync(join(project, ".ppm", "session-baselines", SESSION, "reviewed"))).toBe(false);
  });

  it("refuses a body without files and a reviewed flag, and a session id that cannot name a directory", async () => {
    const bad = await app.request(`http://x/chat/sessions/${SESSION}/file-changes/reviewed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(bad.status).toBe(400);
    expect((await review("not*valid", [])).status).toBe(400);
  });
});

describe("POST /chat/sessions/:id/file-changes/answer — keep and open", () => {
  it("keeps blocks one at a time, and marks the file reviewed with its last one", async () => {
    const a = join(project, "a.ts");
    const base = numbered(40);
    recordBaseline(SESSION, a, base);
    writeFileSync(a, replaceLine(replaceLine(base, 5, "agent 5"), 30, "agent 30"));
    const shown = await listed(SESSION, a);
    const [first, second] = shown.blocks.map((b: any) => b.key);

    const one = await answer(SESSION, "keep", [{ path: a, version: shown.version, keys: [first] }]);
    expect(keptFlags(one.body.data.files[0].file)).toEqual([true, false]);
    expect(one.body.data.undoId).toEqual(expect.any(String));
    const after = await listed(SESSION, a);
    expect(keptFlags(after)).toEqual([true, false]);
    expect(after.reviewed).toBeUndefined();

    const two = await answer(SESSION, "keep", [{ path: a, version: shown.version, keys: [second] }]);
    expect(two.body.data.files[0].file).toMatchObject({ reviewed: true });
    expect(await listed(SESSION, a)).toMatchObject({ reviewed: true });

    // Change: one block open again takes the mark off, and the other answer stands.
    const reopened = await answer(SESSION, "open", [{ path: a, version: shown.version, keys: [first] }]);
    expect(reopened.body.data.files[0].file.reviewed).toBeUndefined();
    expect(keptFlags(await listed(SESSION, a))).toEqual([false, true]);
  });

  it("opens a kept block again when the agent writes into it, and leaves the other answers", async () => {
    const a = join(project, "a.ts");
    const base = numbered(60);
    recordBaseline(SESSION, a, base);
    const once = replaceLine(replaceLine(replaceLine(base, 5, "agent 5"), 30, "agent 30"), 50, "agent 50");
    writeFileSync(a, once);
    const shown = await listed(SESSION, a);
    await answer(SESSION, "keep", [{ path: a, version: shown.version, keys: shown.blocks.slice(0, 2).map((b: any) => b.key) }]);
    expect(keptFlags(await listed(SESSION, a))).toEqual([true, true, false]);

    writeFileSync(a, replaceLine(once, 5, "agent 5, again"));
    const now = await listed(SESSION, a);
    expect(keptFlags(now)).toEqual([false, true, false]);
    expect(now.blocks[0].key).not.toBe(shown.blocks[0].key);
  });

  it("leaves alone a file written since it was drawn, or a block it no longer has", async () => {
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    const shown = await listed(SESSION, a);
    writeFileSync(a, "three, written while the review was on screen\n");

    const moved = await answer(SESSION, "keep", [{ path: a, version: shown.version }]);
    expect(moved.body.data).toEqual({ files: [{ path: a, stale: true, file: expect.objectContaining({ path: a }) }] });
    const now = await listed(SESSION, a);
    expect(keptFlags(now)).toEqual([false]);
    const gone = await answer(SESSION, "keep", [{ path: a, version: now.version, keys: ["0.nothere"] }]);
    expect(gone.body.data.files[0].stale).toBe(true);
    expect(keptFlags(await listed(SESSION, a))).toEqual([false]);
  });

  it("keeps every block of a file when no block is named, as Keep file does", async () => {
    const a = join(project, "a.ts");
    const base = numbered(40);
    recordBaseline(SESSION, a, base);
    writeFileSync(a, replaceLine(replaceLine(base, 5, "agent 5"), 30, "agent 30"));
    const shown = await listed(SESSION, a);
    // Named twice, answered once.
    const res = await answer(SESSION, "keep", [{ path: a, version: shown.version }, { path: a, version: shown.version }]);
    expect(res.body.data.files).toEqual([{ path: a, file: expect.objectContaining({ reviewed: true }) }]);
  });

  it("does not carry a kept block over to a different base, even when the block reads the same", async () => {
    const a = join(project, "a.ts");
    const base = numbered(40);
    const agent = replaceLine(replaceLine(base, 5, "agent 5"), 30, "agent 30");
    recordBaseline(SESSION, a, base);
    writeFileSync(a, agent);
    const shown = await listed(SESSION, a);
    await answer(SESSION, "keep", [{ path: a, version: shown.version, keys: [shown.blocks[0].key] }]);
    // The agent takes line 5 back, the file is marked reviewed like that, then line 5 comes back.
    writeFileSync(a, replaceLine(base, 30, "agent 30"));
    await review(SESSION, [{ path: a, version: (await listed(SESSION, a)).version }]);
    writeFileSync(a, agent);

    const now = await listed(SESSION, a);
    expect(now.sinceReview).toBe(true);
    expect(now.blocks.map((b: any) => b.key)).toEqual([shown.blocks[0].key]);
    expect(keptFlags(now)).toEqual([false]);
  });

  it("answers a binary file whole", async () => {
    const bin = join(project, "logo.bin");
    recordBaseline(SESSION, bin, new Uint8Array([0, 1, 2]));
    writeFileSync(bin, new Uint8Array([0, 1, 3]));
    const shown = await listed(SESSION, bin);
    expect(shown).toMatchObject({ binary: true });
    expect(shown.blocks).toBeUndefined();

    expect((await answer(SESSION, "keep", [{ path: bin, version: shown.version, keys: ["0.x"] }])).body.data.files[0].stale).toBe(true);
    expect((await answer(SESSION, "keep", [{ path: bin, version: shown.version }])).body.data.files[0].file).toMatchObject({ reviewed: true });
    expect((await answer(SESSION, "open", [{ path: bin, version: shown.version }])).body.data.files[0].file.reviewed).toBeUndefined();
  });
});

describe("POST /chat/sessions/:id/file-changes/answer — revert", () => {
  it("puts one block back byte for byte and leaves the rest of the file as it is", async () => {
    const a = join(project, "crlf.txt");
    const base = "keep\r\n".repeat(3) + "old 4\r\n" + "keep\r\n".repeat(10) + "old 15\r\nlast";
    recordBaseline(SESSION, a, base);
    writeFileSync(a, base.replace("old 4\r\n", "new 4\r\nmore\r\n").replace("old 15\r\nlast", "new 15\r\nlast!"));
    const shown = await listed(SESSION, a);

    const res = await answer(SESSION, "revert", [{ path: a, version: shown.version, keys: [shown.blocks[1].key] }]);
    expect(readFileSync(a, "utf8")).toBe(base.replace("old 4\r\n", "new 4\r\nmore\r\n"));
    expect(res.body.data.files[0].file.blocks).toEqual([{ key: shown.blocks[0].key, added: 2, removed: 1 }]);
    // Still cut against the same "before".
    expect(res.body.data.files[0].file.base).toBe(shown.base);
    expect(res.body.data.undoId).toEqual(expect.any(String));
  });

  it("keeps a byte-order mark through a revert", async () => {
    const a = join(project, "bom.cs");
    const bom = (text: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    recordBaseline(SESSION, a, bom("a\nb\n"));
    writeFileSync(a, bom("a\nB\n"));
    const shown = await listed(SESSION, a);
    await answer(SESSION, "revert", [{ path: a, version: shown.version, keys: [shown.blocks[0].key] }]);
    expect(new Uint8Array(readFileSync(a))).toEqual(bom("a\nb\n"));
  });

  it("reverts whole files: deletes one the session created, writes back one it deleted, and undoes all of it", async () => {
    const created = join(project, "created.ts");
    const deleted = join(project, "deleted.ts");
    const edited = join(project, "edited.ts");
    recordBaseline(SESSION, created, null);
    recordBaseline(SESSION, deleted, "gone\nnow\n");
    recordBaseline(SESSION, edited, "a\n");
    writeFileSync(created, "new\n");
    writeFileSync(edited, "b\n");
    const files = (await changes(SESSION)).body.data.files.map((f: any) => ({ path: f.path, version: f.version }));

    const res = await answer(SESSION, "revert", files);
    expect(res.body.data.files.map((f: any) => f.file)).toEqual([null, null, null]);
    expect(existsSync(created)).toBe(false);
    expect(readFileSync(deleted, "utf8")).toBe("gone\nnow\n");
    expect(readFileSync(edited, "utf8")).toBe("a\n");
    expect((await changes(SESSION)).body.data.files).toEqual([]);

    const back = await undo(SESSION, res.body.data.undoId);
    expect(back.body.data.stale).toBeUndefined();
    expect(readFileSync(created, "utf8")).toBe("new\n");
    expect(existsSync(deleted)).toBe(false);
    expect(readFileSync(edited, "utf8")).toBe("b\n");
    expect((await changes(SESSION)).body.data.files).toHaveLength(3);
  });

  it("answers a file it cannot write with why, and still writes the others, with an Undo for them", async () => {
    const a = join(project, "a.ts");
    const b = join(project, "dir", "b.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    // The session deleted dir/b.ts, and a file named dir stands where its folder was: it cannot be written back.
    recordBaseline(SESSION, b, "bravo\n");
    writeFileSync(join(project, "dir"), "not a folder\n");
    const files = (await changes(SESSION)).body.data.files.map((f: any) => ({ path: f.path, version: f.version }));
    expect(files.map((f: any) => f.path)).toEqual([a, b]);

    const res = await answer(SESSION, "revert", files);
    expect(res.status).toBe(200);
    expect(res.body.data.files.map((f: any) => [f.path, typeof f.error])).toEqual([[a, "undefined"], [b, "string"]]);
    expect(readFileSync(a, "utf8")).toBe("one\n");
    expect((await undo(SESSION, res.body.data.undoId)).body.data.stale).toBeUndefined();
    expect(readFileSync(a, "utf8")).toBe("two\n");
  });

  it("leaves a file written while the others are being reverted, and answers it stale", async () => {
    // Two names for one file: reverting a.ts writes b.ts after b.ts was worked out, as an agent
    // still running would.
    const a = join(project, "a.ts");
    const b = join(project, "b.ts");
    writeFileSync(a, "two\n");
    linkSync(a, b);
    recordBaseline(SESSION, a, "one\n");
    recordBaseline(SESSION, b, "uno\n");
    const files = (await changes(SESSION)).body.data.files.map((f: any) => ({ path: f.path, version: f.version }));
    expect(files.map((f: any) => f.path)).toEqual([a, b]);

    const res = await answer(SESSION, "revert", files);
    expect(res.body.data.files.map((f: any) => [f.path, f.stale === true])).toEqual([[a, false], [b, true]]);
    expect(readFileSync(a, "utf8")).toBe("one\n");
    expect((await undo(SESSION, res.body.data.undoId)).body.data.stale).toBeUndefined();
    expect(readFileSync(b, "utf8")).toBe("two\n");
  });

  it("writes nothing when what Undo needs cannot be saved first", async () => {
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    // A file where the undo folder goes: no journal can be written there.
    writeFileSync(join(home, "session-baselines", SESSION, "undo"), "");
    const res = await answer(SESSION, "revert", [{ path: a, version: (await listed(SESSION, a)).version }]);
    expect(res.body.data.undoId).toBeUndefined();
    expect(res.body.data.files).toEqual([{ path: a, error: expect.stringContaining("Undo"), file: expect.objectContaining({ path: a }) }]);
    expect(readFileSync(a, "utf8")).toBe("two\n");
  });

  it("deletes a file the session created once its last block is reverted", async () => {
    const a = join(project, "created.ts");
    recordBaseline(SESSION, a, null);
    writeFileSync(a, "new\n");
    const shown = await listed(SESSION, a);
    expect((await answer(SESSION, "revert", [{ path: a, version: shown.version, keys: [shown.blocks[0].key] }])).body.data.files[0].file).toBeNull();
    expect(existsSync(a)).toBe(false);
  });

  it("leaves alone a file written since it was drawn, or a block it no longer has", async () => {
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    const shown = await listed(SESSION, a);
    writeFileSync(a, "three\n");
    const res = await answer(SESSION, "revert", [{ path: a, version: shown.version }]);
    expect(res.body.data.files[0].stale).toBe(true);
    expect(res.body.data.undoId).toBeUndefined();
    expect(readFileSync(a, "utf8")).toBe("three\n");
    // …and a block it no longer has.
    const gone = await answer(SESSION, "revert", [{ path: a, version: (await listed(SESSION, a)).version, keys: ["0.nothere"] }]);
    expect(gone.body.data.files[0].stale).toBe(true);
    expect(readFileSync(a, "utf8")).toBe("three\n");
  });

  it("refuses to write back a file that is not UTF-8 text", async () => {
    const a = join(project, "latin1.txt");
    const latin1 = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));
    recordBaseline(SESSION, a, latin1("caf\xe9\n"));
    writeFileSync(a, latin1("caf\xe9\nmore\n"));
    const shown = await listed(SESSION, a);
    for (const keys of [[shown.blocks[0].key], undefined]) {
      const res = await answer(SESSION, "revert", [{ path: a, version: shown.version, ...(keys ? { keys } : {}) }]);
      expect(res.body.data.files[0].error).toContain("not plain UTF-8");
    }
    expect(new Uint8Array(readFileSync(a))).toEqual(latin1("caf\xe9\nmore\n"));
  });

  it("reverts a binary file from git HEAD, and refuses one with no copy from before", async () => {
    git("init", "-q");
    const committed = join(project, "committed.bin");
    writeFileSync(committed, new Uint8Array([0, 1, 2]));
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(committed, new Uint8Array([0, 1, 3]));
    const fromHead = await listed(SESSION, committed);
    // HEAD is only consulted for a path the browser names.
    const head = (await changes(SESSION, [committed])).body.data.files[0];
    expect(fromHead).toBeUndefined();
    await answer(SESSION, "revert", [{ path: committed, version: head.version }]);
    expect(new Uint8Array(readFileSync(committed))).toEqual(new Uint8Array([0, 1, 2]));

    const kept = join(project, "kept.bin");
    recordBaseline(SESSION, kept, new Uint8Array([0, 9]));
    writeFileSync(kept, new Uint8Array([0, 8]));
    const res = await answer(SESSION, "revert", [{ path: kept, version: (await listed(SESSION, kept)).version }]);
    expect(res.body.data.files[0].error).toContain("no copy");
    expect(new Uint8Array(readFileSync(kept))).toEqual(new Uint8Array([0, 8]));
  });

  it("never writes into the PPM directory", async () => {
    process.env.PPM_HOME = join(project, ".ppm");
    _resetPpmDir();
    mkdirSync(join(project, ".ppm"), { recursive: true });
    writeFileSync(join(project, ".ppm", "ppm.db"), "credentials");
    git("init", "-q");
    const res = await answer(SESSION, "revert", [{ path: join(project, ".ppm", "ppm.db"), version: "" }]);
    expect(res.body.data.files[0].stale).toBe(true);
    expect(readFileSync(join(project, ".ppm", "ppm.db"), "utf8")).toBe("credentials");
  });

  it("refuses a body that does not say what to do with which version of which file", async () => {
    const bad = [
      { files: [{ path: "a.ts", version: "" }] },
      { answer: "approve", files: [{ path: "a.ts", version: "" }] },
      { answer: "keep", files: [] },
      { answer: "keep", files: [{ path: "a.ts" }] },
      { answer: "keep", files: [{ path: "a.ts", version: "", keys: [] }] },
      { answer: "keep", files: [{ path: "a.ts", version: "", keys: "k" }] },
    ];
    for (const body of bad) {
      const res = await app.request(`http://x/chat/sessions/${SESSION}/file-changes/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect((await answer("not*valid", "keep", [{ path: "a.ts", version: "" }])).status).toBe(400);
  });
});

describe("POST /chat/sessions/:id/file-changes/undo", () => {
  it("undoes a revert, and the mark its last open block made", async () => {
    const a = join(project, "a.ts");
    const base = numbered(40);
    const agent = replaceLine(replaceLine(base, 5, "agent 5"), 30, "agent 30");
    recordBaseline(SESSION, a, base);
    writeFileSync(a, agent);
    const shown = await listed(SESSION, a);
    await answer(SESSION, "keep", [{ path: a, version: shown.version, keys: [shown.blocks[0].key] }]);
    const res = await answer(SESSION, "revert", [{ path: a, version: shown.version, keys: [shown.blocks[1].key] }]);
    expect(res.body.data.files[0].file).toMatchObject({ reviewed: true });

    const back = await undo(SESSION, res.body.data.undoId);
    expect(back.body.data.files).toEqual([{ path: a, file: expect.objectContaining({ path: a }) }]);
    expect(readFileSync(a, "utf8")).toBe(agent);
    const now = await listed(SESSION, a);
    expect(now.reviewed).toBeUndefined();
    expect(keptFlags(now)).toEqual([true, false]);
    // Once is all: the journal is gone.
    expect((await undo(SESSION, res.body.data.undoId)).body.data).toEqual({ stale: true, files: [] });
  });

  it("puts a reverted block back after another block of the file was reverted", async () => {
    const a = join(project, "a.ts");
    const base = numbered(60);
    recordBaseline(SESSION, a, base);
    writeFileSync(a, replaceLine(replaceLine(replaceLine(base, 5, "agent 5"), 30, "agent 30"), 50, "agent 50"));
    const shown = await listed(SESSION, a);
    const first = await answer(SESSION, "revert", [{ path: a, version: shown.version, keys: [shown.blocks[0].key] }]);
    const mid = await listed(SESSION, a);
    await answer(SESSION, "revert", [{ path: a, version: mid.version, keys: [mid.blocks[0].key] }]);

    expect((await undo(SESSION, first.body.data.undoId)).body.data.stale).toBeUndefined();
    expect(readFileSync(a, "utf8")).toBe(replaceLine(replaceLine(base, 5, "agent 5"), 50, "agent 50"));
  });

  it("refuses to undo over lines written since, and then puts back no file at all", async () => {
    const a = join(project, "a.ts");
    const b = join(project, "b.ts");
    recordBaseline(SESSION, a, numbered(10));
    recordBaseline(SESSION, b, numbered(10));
    writeFileSync(a, replaceLine(numbered(10), 5, "agent 5"));
    writeFileSync(b, replaceLine(numbered(10), 5, "agent 5"));
    const files = (await changes(SESSION)).body.data.files.map((f: any) => ({ path: f.path, version: f.version }));
    const res = await answer(SESSION, "revert", files);
    writeFileSync(a, replaceLine(numbered(10), 6, "someone else"));

    const back = await undo(SESSION, res.body.data.undoId);
    expect(back.body.data.stale).toBe(true);
    expect(readFileSync(a, "utf8")).toBe(replaceLine(numbered(10), 6, "someone else"));
    expect(readFileSync(b, "utf8")).toBe(numbered(10));
  });

  it("puts back every file or none: one it cannot write takes back the ones written before it", async () => {
    const a = join(project, "a.ts");
    const made = join(project, "dir", "made.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    recordBaseline(SESSION, made, null);
    mkdirSync(join(project, "dir"));
    writeFileSync(made, "made\n");
    const files = (await changes(SESSION)).body.data.files.map((f: any) => ({ path: f.path, version: f.version }));
    expect(files.map((f: any) => f.path)).toEqual([a, made]);
    const res = await answer(SESSION, "revert", files);
    expect(readFileSync(a, "utf8")).toBe("one\n");
    expect(existsSync(made)).toBe(false);
    // A file named dir now stands where the folder was, so made.ts cannot be written back.
    rmSync(join(project, "dir"), { recursive: true });
    writeFileSync(join(project, "dir"), "not a folder\n");

    const failed = await undo(SESSION, res.body.data.undoId);
    expect(failed.status).toBe(500);
    expect(failed.body.error).toContain("Nothing was undone");
    expect(readFileSync(a, "utf8")).toBe("one\n");

    // Once it can be written, the same Undo puts both back.
    rmSync(join(project, "dir"));
    const back = await undo(SESSION, res.body.data.undoId);
    expect(back.body.data.stale).toBeUndefined();
    expect(readFileSync(a, "utf8")).toBe("two\n");
    expect(readFileSync(made, "utf8")).toBe("made\n");
  });

  it("undoes a keep while nothing has answered the file since", async () => {
    const a = join(project, "a.ts");
    const base = numbered(40);
    recordBaseline(SESSION, a, base);
    writeFileSync(a, replaceLine(replaceLine(base, 5, "agent 5"), 30, "agent 30"));
    const shown = await listed(SESSION, a);
    const [first, second] = shown.blocks.map((blk: any) => blk.key);

    const kept = await answer(SESSION, "keep", [{ path: a, version: shown.version, keys: [first] }]);
    await undo(SESSION, kept.body.data.undoId);
    expect(keptFlags(await listed(SESSION, a))).toEqual([false, false]);

    const again = await answer(SESSION, "keep", [{ path: a, version: shown.version, keys: [first] }]);
    await answer(SESSION, "keep", [{ path: a, version: shown.version, keys: [second] }]);
    expect((await undo(SESSION, again.body.data.undoId)).body.data.stale).toBe(true);
    expect(await listed(SESSION, a)).toMatchObject({ reviewed: true });
  });

  it("reads a journal only from the session's own undo directory", async () => {
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    const [mark] = answerRecordFiles(SESSION, a)!;
    // A journal-shaped file one directory up, which would write a mark if it were ever obeyed.
    const forged = { id: "forged", entries: [{ path: a, records: { before: ["tampered", null], after: [null, null] } }], createdAt: "" };
    writeFileSync(join(home, "session-baselines", SESSION, "forged.json"), JSON.stringify(forged));
    expect((await undo(SESSION, "../forged")).body.data).toEqual({ stale: true, files: [] });
    expect(existsSync(mark)).toBe(false);
  });

  it("drops a journal a day old", async () => {
    const a = join(project, "a.ts");
    recordBaseline(SESSION, a, "one\n");
    writeFileSync(a, "two\n");
    const old = await answer(SESSION, "keep", [{ path: a, version: (await listed(SESSION, a)).version }]);
    const dir = join(home, "session-baselines", SESSION, "undo");
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(join(dir, `${old.body.data.undoId}.json`), dayAgo, dayAgo);
    await answer(SESSION, "open", [{ path: a, version: (await listed(SESSION, a)).version }]);
    expect(existsSync(join(dir, `${old.body.data.undoId}.json`))).toBe(false);
  });

  it("refuses a body without an undo id, and an id that names no journal", async () => {
    const res = await app.request(`http://x/chat/sessions/${SESSION}/file-changes/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await undo(SESSION, "../../escape")).body.data).toEqual({ stale: true, files: [] });
  });
});

describe("POST /chat/sessions/:id/file-changes/revert-turn", () => {
  beforeEach(() => _resetSessionFileHistory());

  async function call(file: string, id: string, next: string): Promise<void> {
    await observeFile(SESSION, file, id, "before");
    writeFileSync(file, next);
    await observeFile(SESSION, file, id, "after");
  }

  async function revertTurn(sessionId: string, body: unknown) {
    const res = await app.request(`http://x/chat/sessions/${sessionId}/file-changes/revert-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("previews a turn, reverts it at the versions shown, and undoes it", async () => {
    const a = join(project, "a.ts");
    const base = numbered(40);
    writeFileSync(a, base);
    const one = replaceLine(base, 5, "agent 5");
    await call(a, "toolu_1", one);
    const two = replaceLine(one, 30, "agent 30");
    await call(a, "toolu_2", two);

    const preview = await revertTurn(SESSION, { calls: ["toolu_1"] });
    expect(preview.status).toBe(200);
    expect(preview.body.data.files).toEqual([expect.objectContaining({ path: a, action: "edit", changes: 1, skipped: [] })]);
    expect(readFileSync(a, "utf8")).toBe(two);

    const shown = preview.body.data.files.map((f: any) => ({ path: f.path, version: f.version }));
    const applied = await revertTurn(SESSION, { calls: ["toolu_1"], apply: shown });
    expect(applied.body.data.undoId).toEqual(expect.any(String));
    expect(readFileSync(a, "utf8")).toBe(replaceLine(base, 30, "agent 30"));

    expect((await undo(SESSION, applied.body.data.undoId)).body.data.stale).toBeUndefined();
    expect(readFileSync(a, "utf8")).toBe(two);
  });

  it("writes nothing once a file moved on since the preview", async () => {
    const a = join(project, "a.ts");
    writeFileSync(a, numbered(10));
    await call(a, "toolu_1", replaceLine(numbered(10), 5, "agent 5"));
    const preview = await revertTurn(SESSION, { calls: ["toolu_1"] });
    const moved = replaceLine(replaceLine(numbered(10), 5, "agent 5"), 9, "someone else");
    writeFileSync(a, moved);

    const res = await revertTurn(SESSION, { calls: ["toolu_1"], apply: preview.body.data.files.map((f: any) => ({ path: f.path, version: f.version })) });
    expect(res.body.data.stale).toBe(true);
    expect(readFileSync(a, "utf8")).toBe(moved);
  });

  it("refuses a request that names no call, or a shown file without its version", async () => {
    expect((await revertTurn(SESSION, {})).status).toBe(400);
    expect((await revertTurn(SESSION, { calls: [""] })).status).toBe(400);
    expect((await revertTurn(SESSION, { calls: ["toolu_1"], apply: [{ path: "/x" }] })).status).toBe(400);
    expect((await revertTurn(SESSION, { calls: ["toolu_1"], apply: "all" })).status).toBe(400);
    expect((await revertTurn("not*valid", { calls: ["toolu_1"] })).status).toBe(400);
  });
});
