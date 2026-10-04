import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChangesService } from "../../../../src/services/git-changes/git-changes.service.ts";
import { gitWorkflowService, parseStashSubject } from "../../../../src/services/git-workflow/git-workflow.service.ts";

let root: string;
let repo: string;

async function git(args: string[], cwd = repo): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.x" },
  });
  const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (await proc.exited !== 0) throw new Error(`git ${args.join(" ")}: ${errText}`);
  return out;
}
const write = (p: string, text: string) => writeFileSync(join(repo, p), text);
const head = async (cwd = repo) => (await git(["rev-parse", "HEAD"], cwd)).trim();

/** Set environment variables for the length of `run`, then put back what was there. */
async function withEnv<T>(vars: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// SHA-256 object names need git 2.29 or later.
const sha256Repos = (() => {
  const dir = mkdtempSync(join(tmpdir(), "ppm-sha256-probe-"));
  try {
    return Bun.spawnSync(["git", "init", "-q", "--object-format=sha256", dir]).exitCode === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// git in German, where its translations are installed (`git stash -h` then starts "Verwendung:").
const GERMAN = { LC_ALL: "de_DE.UTF-8", LANGUAGE: "de" };
const gitSpeaksGerman = !Bun.spawnSync(["git", "stash", "-h"], { env: { ...process.env, ...GERMAN } })
  .stdout.toString().startsWith("usage:");

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ppm-workflow-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  await git(["init", "-q", "-b", "main"]);
  write("a.txt", "one\n");
  await git(["add", "a.txt"]);
  await git(["commit", "-qm", "first"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("undoLastCommit", () => {
  it("takes the commit back into the index and returns its whole message", async () => {
    write("a.txt", "two\n");
    await git(["commit", "-qam", "Second commit\n\nWith a body."]);
    const { message } = await gitWorkflowService.undoLastCommit(repo, await head());
    expect(message).toBe("Second commit\n\nWith a body.");
    expect((await git(["log", "--format=%s"])).trim()).toBe("first");
    expect(await git(["status", "--porcelain=v1"])).toBe("M  a.txt\n");
  });

  it("refuses a commit that is no longer the last one, and takes nothing back", async () => {
    write("a.txt", "two\n");
    await git(["commit", "-qam", "second"]);
    const meant = await head();
    write("a.txt", "three\n");
    await git(["commit", "-qam", "third, from a terminal"]);
    await expect(gitWorkflowService.undoLastCommit(repo, meant)).rejects.toThrow(/no longer/);
    expect((await git(["log", "--format=%s"])).trim().split("\n")).toEqual(["third, from a terminal", "second", "first"]);
  });

  it("moves nothing when a commit lands between reading HEAD and moving it", async () => {
    write("a.txt", "two\n");
    await git(["commit", "-qam", "second"]);
    const meant = await head();
    gitChangesService.invalidate(repo);
    const read = await gitChangesService.getChanges(repo);
    write("a.txt", "three\n");
    await git(["commit", "-qam", "third"]);
    const third = await head();
    // What the service read is the commit it was asked for; HEAD is already past it.
    const changes = spyOn(gitChangesService, "getChanges").mockResolvedValue(read);
    try {
      await expect(gitWorkflowService.undoLastCommit(repo, meant)).rejects.toThrow();
    } finally {
      changes.mockRestore();
    }
    expect(await head()).toBe(third);
    expect(await git(["status", "--porcelain=v1"])).toBe("");
  });

  it("refuses a hash too short to name one commit", async () => {
    write("a.txt", "two\n");
    await git(["commit", "-qam", "second"]);
    const last = await head();
    await expect(gitWorkflowService.undoLastCommit(repo, last.slice(0, 7))).rejects.toThrow(/Invalid commit id/);
    expect(await head()).toBe(last);
  });

  // What `/commit` answers with is 40 digits, which in a SHA-256 repository is the start of 64.
  it.skipIf(!sha256Repos)("takes the 40 digits /commit answers with in a SHA-256 repository", async () => {
    const r = join(root, "sha256");
    await git(["init", "-q", "-b", "main", "--object-format=sha256", r], root);
    writeFileSync(join(r, "a.txt"), "one\n");
    await git(["add", "a.txt"], r);
    await git(["commit", "-qm", "first"], r);
    writeFileSync(join(r, "a.txt"), "two\n");
    await git(["commit", "-qam", "second"], r);
    const last = await head(r);
    expect(last).toHaveLength(64);
    await gitWorkflowService.undoLastCommit(r, last.slice(0, 40));
    expect((await git(["log", "--format=%s"], r)).trim()).toBe("first");
  });

  it("refuses the root commit", async () => {
    await expect(gitWorkflowService.undoLastCommit(repo, await head())).rejects.toThrow(/first commit/);
  });

  it("refuses a commit that is already on the remote", async () => {
    await git(["init", "-q", "--bare", "-b", "main", join(root, "remote.git")], root);
    await git(["remote", "add", "origin", join(root, "remote.git")]);
    write("a.txt", "two\n");
    await git(["commit", "-qam", "second"]);
    await git(["push", "-q", "-u", "origin", "main"]);
    await expect(gitWorkflowService.undoLastCommit(repo, await head())).rejects.toThrow(/already on the remote/);
  });

  it("refuses while a merge is under way", async () => {
    await git(["checkout", "-q", "-b", "side"]);
    write("a.txt", "side\n");
    await git(["commit", "-qam", "side"]);
    await git(["checkout", "-q", "main"]);
    write("a.txt", "main\n");
    await git(["commit", "-qam", "main"]);
    await git(["merge", "side"]).catch(() => undefined);
    await expect(gitWorkflowService.undoLastCommit(repo, await head())).rejects.toThrow(/merge first/);
  });
});

describe("publish", () => {
  it("pushes the branch and sets its upstream", async () => {
    await git(["init", "-q", "--bare", "-b", "main", join(root, "remote.git")], root);
    await git(["remote", "add", "origin", join(root, "remote.git")]);
    await git(["checkout", "-q", "-b", "topic"]);
    expect(await gitWorkflowService.publish(repo)).toEqual({ remote: "origin", branch: "topic" });
    expect((await git(["rev-parse", "--abbrev-ref", "topic@{upstream}"])).trim()).toBe("origin/topic");
  });

  it("says why when there is no remote", async () => {
    await expect(gitWorkflowService.publish(repo)).rejects.toThrow(/no remote/);
  });
});

describe("stash", () => {
  it("lists, applies, pops and drops by index and id", async () => {
    write("a.txt", "stash me\n");
    await gitWorkflowService.stash(repo, { message: "first stash" });
    write("b.txt", "untracked\n");
    await gitWorkflowService.stash(repo, { includeUntracked: true });

    const list = await gitWorkflowService.listStashes(repo);
    expect(list.map((s) => [s.index, s.branch, s.message])).toEqual([
      [0, "main", expect.stringContaining("first")],
      [1, "main", "first stash"],
    ]);
    expect(list[0]!.hash).toMatch(/^[0-9a-f]{40}$/);

    await gitWorkflowService.stashAction(repo, "apply", 1, list[1]!.hash);
    expect(await git(["status", "--porcelain=v1"])).toBe(" M a.txt\n");
    await git(["checkout", "--", "a.txt"]);

    await gitWorkflowService.stashAction(repo, "drop", 1, list[1]!.hash);
    await gitWorkflowService.stashAction(repo, "pop", 0, list[0]!.hash);
    expect(await gitWorkflowService.listStashes(repo)).toEqual([]);
    expect(await git(["status", "--porcelain=v1"])).toBe("?? b.txt\n");
  });

  it("brings what was staged back staged", async () => {
    write("a.txt", "staged\n");
    await git(["add", "a.txt"]);
    write("a.txt", "staged\nand not\n");
    await gitWorkflowService.stash(repo);
    const [top] = await gitWorkflowService.listStashes(repo);
    expect(await gitWorkflowService.stashAction(repo, "pop", 0, top!.hash)).toEqual({ indexRestored: true });
    expect(await git(["status", "--porcelain=v1"])).toBe("MM a.txt\n");
  });

  /** A stash whose staged part no longer applies on its own. */
  async function stashWhoseIndexNoLongerFits() {
    write("a.txt", "1\n2\n3\n4\n5\n6\n7\n");
    await git(["commit", "-qam", "seven lines"]);
    write("a.txt", "1\n2\n3\nD\n5\n6\n7\n");
    await git(["add", "a.txt"]);
    await gitWorkflowService.stash(repo);
    // A change inside the staged block's context: the index patch no longer
    // applies on its own, while a three-way merge of the work still does.
    write("a.txt", "A\n2\n3\n4\n5\n6\n7\n");
    await git(["commit", "-qam", "first line"]);
    const [top] = await gitWorkflowService.listStashes(repo);
    return top!;
  }

  it("still applies the work when the staged part no longer fits, and says so", async () => {
    const top = await stashWhoseIndexNoLongerFits();
    expect(await gitWorkflowService.stashAction(repo, "apply", 0, top.hash)).toEqual({ indexRestored: false });
    expect(await git(["status", "--porcelain=v1"])).toBe(" M a.txt\n");
    expect(await git(["diff"])).toContain("+D");
  });

  // The fallback is decided by git's own words, which follow the user's locale.
  it.skipIf(!gitSpeaksGerman)("falls back the same way when git speaks another language", async () => {
    const top = await stashWhoseIndexNoLongerFits();
    const result = await withEnv(GERMAN, () => gitWorkflowService.stashAction(repo, "pop", 0, top.hash));
    expect(result).toEqual({ indexRestored: false });
    expect(await git(["diff"])).toContain("+D");
    expect(await gitWorkflowService.listStashes(repo)).toEqual([]);
  });

  it("refuses when the index no longer names the stash on screen", async () => {
    write("a.txt", "x\n");
    await gitWorkflowService.stash(repo);
    const [old] = await gitWorkflowService.listStashes(repo);
    write("a.txt", "y\n");
    await gitWorkflowService.stash(repo);
    await expect(gitWorkflowService.stashAction(repo, "drop", 0, old!.hash)).rejects.toThrow(/changed/);
    expect(await gitWorkflowService.listStashes(repo)).toHaveLength(2);
  });
});

describe("pull", () => {
  // The developer's own `pull.rebase` would decide these tests otherwise.
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  beforeEach(async () => {
    process.env.GIT_CONFIG_GLOBAL = join(root, "empty-gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
    await git(["config", "user.name", "T"]);
    await git(["config", "user.email", "t@e.x"]);
    // Diverge: one commit on the remote that this clone lacks, one here it lacks.
    await git(["init", "-q", "--bare", "-b", "main", join(root, "remote.git")], root);
    await git(["remote", "add", "origin", join(root, "remote.git")]);
    await git(["push", "-q", "-u", "origin", "main"]);
    await git(["clone", "-q", join(root, "remote.git"), join(root, "other")], root);
    writeFileSync(join(root, "other", "b.txt"), "theirs\n");
    await git(["add", "b.txt"], join(root, "other"));
    await git(["commit", "-qm", "theirs"], join(root, "other"));
    await git(["push", "-q"], join(root, "other"));
    write("c.txt", "ours\n");
    await git(["add", "c.txt"]);
    await git(["commit", "-qm", "ours"]);
  });
  afterEach(() => {
    for (const [key, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.system]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("merges a diverged branch when the repository does not say how", async () => {
    await gitWorkflowService.pull(repo);
    expect((await git(["log", "-1", "--format=%P"])).trim().split(" ")).toHaveLength(2);
    expect((await git(["ls-files"])).split("\n")).toEqual(["a.txt", "b.txt", "c.txt", ""]);
  });

  it("leaves a configured rebase to git", async () => {
    await git(["config", "pull.rebase", "true"]);
    await gitWorkflowService.pull(repo);
    expect((await git(["log", "--format=%s"])).trim().split("\n")).toEqual(["ours", "theirs", "first"]);
  });

  it("leaves a rebase configured for the branch alone to git", async () => {
    await git(["config", "branch.main.rebase", "true"]);
    await gitWorkflowService.pull(repo);
    expect((await git(["log", "--format=%s"])).trim().split("\n")).toEqual(["ours", "theirs", "first"]);
  });

  it("keeps pull.ff = only refusing what it cannot fast-forward", async () => {
    await git(["config", "pull.ff", "only"]);
    const head = (await git(["rev-parse", "HEAD"])).trim();
    // Not git's words, which are in the user's language: that nothing was merged.
    await expect(gitWorkflowService.pull(repo)).rejects.toThrow();
    expect((await git(["rev-parse", "HEAD"])).trim()).toBe(head);
  });
});

describe("parseStashSubject", () => {
  it("reads named and automatic stash subjects", () => {
    expect(parseStashSubject("On main: wip on lanes")).toEqual({ branch: "main", message: "wip on lanes" });
    expect(parseStashSubject("WIP on feat/x: abc1234 Fix it")).toEqual({ branch: "feat/x", message: "Fix it" });
    expect(parseStashSubject("autostash")).toEqual({ branch: null, message: "autostash" });
  });
});

describe("operation", () => {
  async function conflict() {
    await git(["config", "user.name", "T"]);
    await git(["config", "user.email", "t@e.x"]);
    await git(["checkout", "-q", "-b", "side"]);
    write("a.txt", "side\n");
    await git(["commit", "-qam", "side"]);
    await git(["checkout", "-q", "main"]);
    write("a.txt", "main\n");
    await git(["commit", "-qam", "main"]);
    await git(["merge", "side"]).catch(() => undefined);
  }

  it("refuses to continue while a conflict is left", async () => {
    await conflict();
    await expect(gitWorkflowService.operation(repo, "continue")).rejects.toThrow(/Resolve every conflict/);
  });

  it("continues a resolved merge with git's own message, without an editor", async () => {
    await conflict();
    write("a.txt", "both\n");
    await git(["add", "a.txt"]);
    expect(await gitWorkflowService.operation(repo, "continue")).toBe("merge");
    expect((await git(["log", "-1", "--format=%P"])).trim().split(" ")).toHaveLength(2);
    expect((await git(["log", "-1", "--format=%s"])).trim()).toBe("Merge branch 'side'");
  });

  it("aborts, putting the tree back", async () => {
    await conflict();
    expect(await gitWorkflowService.operation(repo, "abort")).toBe("merge");
    expect(await git(["status", "--porcelain=v1"])).toBe("");
    expect((await git(["show", "HEAD:a.txt"])).trim()).toBe("main");
  });

  it("says so when nothing is under way", async () => {
    await expect(gitWorkflowService.operation(repo, "abort")).rejects.toThrow(/no merge/);
  });
});
