/**
 * The files a session's shell commands changed: each command bracketed with `git status`, a
 * "before" kept for every file whose status or stat moved across it. Real repositories and
 * real commands, so what is asserted is what git reports, not a model of it.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  captureBaseline,
  listBaselines,
  readBaseline,
} from "../../../src/services/session-file-baselines/session-file-baselines.service.ts";
import {
  _resetShellChangeTracker,
  beginShellCommand,
  commandPaths,
  endShellCommand,
  noteFileToolWrite,
  parseStatus,
} from "../../../src/services/session-file-baselines/shell-change-tracker.ts";
import { observeFile, readHistory } from "../../../src/services/session-file-baselines/session-file-history.ts";
import { rmRetrying } from "../../helpers/rm-retrying.ts";

// Restore, never delete: the bunfig preload's PPM_HOME shields later test files from ~/.ppm.
const ORIGINAL_PPM_HOME = process.env.PPM_HOME;
const SESSION = "5c0e7a1b-2d3f-4e5a-8b9c-0d1e2f3a4b5c";
const OTHER = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

let ppmHome: string;
let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function initRepo(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(resolve(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
}

let calls = 0;
/** Run `command` in `cwd` the way a Bash tool call would, between the two hooks. */
async function shell(command: string, cwd = repo, sessionId = SESSION): Promise<string[]> {
  const toolUseId = `toolu_${++calls}`;
  await beginShellCommand({ sessionId, toolUseId, cwd, command });
  const r = Bun.spawnSync(["bash", "-c", command], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (r.exitCode !== 0) throw new Error(`${command}: ${r.stderr.toString()}`);
  return (await endShellCommand({ sessionId, toolUseId })).sort();
}

beforeEach(() => {
  ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-shell-changes-home-"));
  root = mkdtempSync(resolve(tmpdir(), "ppm-shell-changes-work-"));
  repo = join(root, "repo");
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
  _resetShellChangeTracker();
  initRepo(repo, { "a.txt": "alpha\n", "b.txt": "bravo\n", "src/c.ts": "export const c = 1;\n" });
});

afterEach(async () => {
  if (ORIGINAL_PPM_HOME === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = ORIGINAL_PPM_HOME;
  _resetPpmDir();
  _resetShellChangeTracker();
  await rmRetrying(ppmHome);
  await rmRetrying(root);
});

// The commands run through bash, which a Windows host may not have on PATH.
describe.skipIf(process.platform === "win32")("a shell command's changes", () => {
  test("a file it creates is kept as one that did not exist", async () => {
    expect(await shell("cp a.txt src/copy.txt")).toEqual([join(repo, "src/copy.txt")]);
    expect(readBaseline(SESSION, join(repo, "src/copy.txt"))).toMatchObject({ existed: false });
  });

  test("a clean file it appends to is kept as HEAD had it", async () => {
    expect(await shell("printf 'more\\n' >> a.txt")).toEqual([join(repo, "a.txt")]);
    expect(readBaseline(SESSION, join(repo, "a.txt"))?.content).toBe("alpha\n");
  });

  test("a file that was already changed is kept as it was just before, not as HEAD had it", async () => {
    writeFileSync(join(repo, "b.txt"), "bravo, edited by hand\n");
    await shell("sed -i 's/hand/sed/' b.txt");
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("bravo, edited by sed\n");
    expect(readBaseline(SESSION, join(repo, "b.txt"))?.content).toBe("bravo, edited by hand\n");
  });

  test("an untracked file it overwrites is kept as it was", async () => {
    writeFileSync(join(repo, "notes.md"), "draft\n");
    await shell("echo final > notes.md");
    expect(readBaseline(SESSION, join(repo, "notes.md"))?.content).toBe("draft\n");
  });

  test("a changed file it does not touch is left alone", async () => {
    writeFileSync(join(repo, "b.txt"), "someone else's work\n");
    writeFileSync(join(repo, "scratch.txt"), "untracked\n");
    expect(await shell("ls > /dev/null")).toEqual([]);
    expect(listBaselines(SESSION)).toEqual([]);
  });

  test("a file it deletes is kept with its content", async () => {
    expect(await shell("rm src/c.ts")).toEqual([join(repo, "src/c.ts")]);
    expect(readBaseline(SESSION, join(repo, "src/c.ts"))?.content).toBe("export const c = 1;\n");
  });

  test("a change it discards is kept, so the review shows what was thrown away", async () => {
    writeFileSync(join(repo, "a.txt"), "work in progress\n");
    expect(await shell("git checkout -- a.txt")).toEqual([join(repo, "a.txt")]);
    expect(readBaseline(SESSION, join(repo, "a.txt"))?.content).toBe("work in progress\n");
  });

  test("an edit committed in the same command is followed across the HEAD move", async () => {
    expect(await shell("printf 'beta\\n' >> b.txt && git commit -qam edit")).toEqual([join(repo, "b.txt")]);
    expect(readBaseline(SESSION, join(repo, "b.txt"))?.content).toBe("bravo\n");
  });

  test("moving only the index records nothing", async () => {
    writeFileSync(join(repo, "a.txt"), "second\n");
    git(repo, "commit", "-qam", "second");
    expect(await shell("git reset -q --soft HEAD~1")).toEqual([]);
  });

  test("a commit of changes made earlier records nothing", async () => {
    writeFileSync(join(repo, "a.txt"), "made by a file tool\n");
    expect(await shell("git commit -qam done")).toEqual([]);
  });

  test("a file the session already kept a before for keeps that one", async () => {
    await captureBaseline(SESSION, join(repo, "a.txt"));
    writeFileSync(join(repo, "a.txt"), "written by Edit\n");
    expect(await shell("printf 'and by the shell\\n' >> a.txt")).toEqual([]);
    expect(readBaseline(SESSION, join(repo, "a.txt"))?.content).toBe("alpha\n");
  });

  test("a file the session already kept a before for still gets the command's two states in its history", async () => {
    const file = join(repo, "a.txt");
    // An Edit first, the way the file-write hook records one.
    await captureBaseline(SESSION, file);
    await observeFile(SESSION, file, "toolu_edit", "before");
    writeFileSync(file, "written by Edit\n");
    await observeFile(SESSION, file, "toolu_edit", "after");

    await shell("sed -i 's/Edit/sed/' a.txt");
    const entries = readHistory(SESSION, file).entries;
    expect(entries.map((e) => [e.phase, e.text])).toEqual([
      ["before", "alpha\n"], ["after", "written by Edit\n"], ["before", "written by Edit\n"], ["after", "written by sed\n"],
    ]);
    expect(entries[2]!.call).toBe(entries[3]!.call);
    expect(entries[2]!.call).not.toBe("toolu_edit");
    expect(readBaseline(SESSION, file)?.content).toBe("alpha\n");
  });

  test("a second command does not replace the first one's before", async () => {
    await shell("printf 'one\\n' >> a.txt");
    await shell("printf 'two\\n' >> a.txt");
    expect(readBaseline(SESSION, join(repo, "a.txt"))?.content).toBe("alpha\n");
  });

  test("a file another session's file tool wrote meanwhile is not put on the command", async () => {
    const toolUseId = "toolu_overlap";
    await beginShellCommand({ sessionId: SESSION, toolUseId, cwd: repo, command: "sleep 1" });
    noteFileToolWrite(OTHER, join(repo, "b.txt"));
    writeFileSync(join(repo, "b.txt"), "the other session's edit\n");
    expect(await endShellCommand({ sessionId: SESSION, toolUseId })).toEqual([]);
  });

  test("each file it changes goes in the session's history under the command, as it was and as it is", async () => {
    writeFileSync(join(repo, "b.txt"), "by hand\n");
    await shell("sed -i 's/hand/sed/' b.txt && printf 'more\\n' >> a.txt");
    const b = readHistory(SESSION, join(repo, "b.txt")).entries;
    const a = readHistory(SESSION, join(repo, "a.txt")).entries;
    expect(b.map((e) => [e.phase, e.text])).toEqual([["before", "by hand\n"], ["after", "by sed\n"]]);
    expect(a.map((e) => [e.phase, e.text])).toEqual([["before", "alpha\n"], ["after", "alpha\nmore\n"]]);
    expect(new Set([...a, ...b].map((e) => e.call)).size).toBe(1);
    expect(a[0]!.call).toMatch(/^toolu_/);
  });

  test("a file another session wrote during the command gets no history from it", async () => {
    const toolUseId = "toolu_overlap_history";
    await beginShellCommand({ sessionId: SESSION, toolUseId, cwd: repo, command: "sleep 1" });
    noteFileToolWrite(OTHER, join(repo, "b.txt"));
    writeFileSync(join(repo, "b.txt"), "the other session's edit\n");
    await endShellCommand({ sessionId: SESSION, toolUseId });
    expect(readHistory(SESSION, join(repo, "b.txt")).entries).toEqual([]);
  });

  test("HEAD's before is the checked-out form, line endings included", async () => {
    const crlf = join(root, "crlf");
    initRepo(crlf, { ".gitattributes": "*.txt text eol=crlf\n", "w.txt": "one\ntwo\n" });
    // Check out again, so the file on disk has the CRLF the attribute asks for.
    unlinkSync(join(crlf, "w.txt"));
    git(crlf, "checkout", "--", "w.txt");
    expect(readFileSync(join(crlf, "w.txt"), "utf8")).toBe("one\r\ntwo\r\n");
    await shell("printf 'three\\r\\n' >> w.txt", crlf);
    expect(readBaseline(SESSION, join(crlf, "w.txt"))?.content).toBe("one\r\ntwo\r\n");
  });
});

describe.skipIf(process.platform === "win32")("which repositories a command is checked in", () => {
  test("one it changes into with cd", async () => {
    initRepo(join(root, "other"), { "x.txt": "x\n" });
    expect(await shell("cd ../other && cp x.txt y.txt")).toEqual([join(root, "other", "y.txt")]);
  });

  test("one it names by path", async () => {
    initRepo(join(root, "other"), { "x.txt": "x\n" });
    expect(await shell(`touch ${join(root, "other", "new.txt").replaceAll("\\", "/")}`)).toEqual([join(root, "other", "new.txt")]);
  });

  test("one the session's file tools wrote in, from a directory outside any", async () => {
    const outside = join(root, "plain");
    mkdirSync(outside);
    noteFileToolWrite(SESSION, join(repo, "a.txt"));
    // Named only through a variable, so only the session's own repositories can find it.
    expect(await shell(`R=../repo; cp "$R/a.txt" "$R/d.txt"`, outside)).toEqual([join(repo, "d.txt")]);
  });

  test("none outside a repository: nothing is kept and nothing fails", async () => {
    const outside = join(root, "plain");
    mkdirSync(outside);
    expect(await shell("echo hi > hi.txt", outside)).toEqual([]);
    expect(listBaselines(SESSION)).toEqual([]);
  });
});

// Made from this process rather than through bash, so these run on every host.
describe("a file HEAD does not have", () => {
  /** Make `change` between the two hooks, as a command would. */
  async function during(change: () => void): Promise<string[]> {
    const toolUseId = `toolu_${++calls}`;
    await beginShellCommand({ sessionId: SESSION, toolUseId, cwd: repo, command: "" });
    change();
    return (await endShellCommand({ sessionId: SESSION, toolUseId })).sort();
  }

  const env = () => join(repo, ".env");

  beforeEach(async () => {
    writeFileSync(env(), "SECRET=1\n");
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-qm", "ignore .env");
    // Its timestamps are what say it was there first, so they must fall before the command.
    await Bun.sleep(10);
  });

  test("is not taken for one the command created when a .gitignore rewrite un-ignores it", async () => {
    expect(await during(() => writeFileSync(join(repo, ".gitignore"), ""))).toEqual([join(repo, ".gitignore")]);
    expect(readBaseline(SESSION, env())).toBeNull();
  });

  test("is not taken for one the command created when it is force-added", async () => {
    expect(await during(() => git(repo, "add", "-f", ".env"))).toEqual([]);
    expect(readBaseline(SESSION, env())).toBeNull();
  });

  test("is not taken for one the command created when it is force-added and committed", async () => {
    expect(await during(() => {
      git(repo, "add", "-f", ".env");
      git(repo, "commit", "-qm", "add .env");
    })).toEqual([]);
    expect(readBaseline(SESSION, env())).toBeNull();
  });

  test("is one the command created when it moved it there, though the file itself is older", async () => {
    expect(await during(() => renameSync(join(repo, "b.txt"), join(repo, "d.txt")))).toEqual([join(repo, "b.txt"), join(repo, "d.txt")]);
    expect(readBaseline(SESSION, join(repo, "d.txt"))).toMatchObject({ existed: false });
  });
});

describe("parseStatus", () => {
  const z = (...records: string[]) => new TextEncoder().encode(records.map((r) => `${r}\0`).join(""));
  const oid = "a".repeat(40);
  const blob = "b".repeat(40);
  const zero = "0".repeat(40);

  test("reads HEAD and every listed path, spaces included", () => {
    const status = parseStatus(z(
      `# branch.oid ${oid}`,
      "# branch.head main",
      `1 .M N... 100644 100644 100644 ${blob} ${blob} src/a file.ts`,
      `1 M. N... 100644 100644 100644 ${blob} ${"c".repeat(40)} staged.ts`,
      `u UU N... 100644 100644 100644 100644 ${blob} ${blob} ${blob} conflict.ts`,
      "? new dir/n.ts",
    ))!;
    expect(status.head).toBe(oid);
    expect([...status.entries.keys()]).toEqual(["src/a file.ts", "staged.ts", "conflict.ts", "new dir/n.ts"]);
    // Only a staged file whose worktree matches the index names the blob on disk.
    expect(status.entries.get("src/a file.ts")).toEqual({});
    expect(status.entries.get("staged.ts")).toEqual({ worktreeOid: "c".repeat(40) });
  });

  test("leaves out submodules and nested repositories, and an untracked twin wins", () => {
    const status = parseStatus(z(
      "# branch.oid (initial)",
      `1 .M S.M. 160000 160000 160000 ${blob} ${blob} vendor/lib`,
      "? nested/",
      `1 D. N... 100644 000000 000000 ${blob} ${zero} kept.txt`,
      "? kept.txt",
    ))!;
    expect(status.head).toBeNull();
    expect([...status.entries]).toEqual([["kept.txt", {}]]);
  });
});

describe("commandPaths", () => {
  test("takes cd, pushd and -C targets, and words that look like paths", () => {
    expect(commandPaths("cd backend && npm test", "/w")).toEqual([resolve("/w", "backend")]);
    expect(commandPaths("pushd ../api; git -C /r/lib status", "/w/x")).toEqual([resolve("/w", "api"), "/r/lib"]);
    expect(commandPaths(`cp src/a.ts "dest dir/b.ts" --out=dist/x.js`, "/w")).toEqual([
      resolve("/w", "src/a.ts"), resolve("/w", "dest dir/b.ts"), resolve("/w", "dist/x.js"),
    ]);
  });

  test("skips variables, plain words and other users' homes", () => {
    expect(commandPaths("echo $HOME/x hello ~bob/y && ls", "/w")).toEqual([]);
  });
});
