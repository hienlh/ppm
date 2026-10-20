/**
 * Where the Assistant's git writes actually land, against real repositories and bare remotes:
 * a push goes to the upstream the card names whatever the repository's push configuration says,
 * a branch named `+main` is refused and, made outside PPM, is published as itself rather than
 * force-pushed over `main`, a discard card names every file the journal will keep no copy of,
 * and a commit whose staged content changed while its card waited is not made.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../src/services/config.service.ts";
import { createRouteCaller } from "../../src/services/assistant-mcp/assistant-route-call.ts";
import { GIT_ROUTES, GIT_TOOL_HANDLERS } from "../../src/services/assistant-mcp/assistant-git-tools.ts";
import type { ApprovalAsk } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";
import type { ToolContext } from "../../src/services/assistant-mcp/assistant-tool-family.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: ENV });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

let root: string;
let repo: string;
let origin: string;
let savedProjects: unknown;

beforeAll(async () => {
  // The order a running PPM has: the server's module graph first, then the lazily built app.
  await import("../../src/server/index.ts");
  savedProjects = configService.get("projects");
  // Loading the whole server graph takes seconds on a busy machine, well past the default hook limit.
}, 60_000);

afterAll(() => {
  configService.set("projects", savedProjects as never);
});

/** A clone of a bare `origin` with one pushed commit, registered as the project "push". */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppm-assistant-push-"));
  origin = join(root, "origin.git");
  git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first"]);
  git(repo, ["remote", "add", "origin", origin]);
  git(repo, ["push", "-q", "-u", "origin", "main"]);
  configService.set("projects", [{ name: "push", path: repo }]);
  // Eight real git processes per test; on Windows under a full suite that alone can pass five seconds.
}, 30_000);

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  asked.length = 0;
});

const asked: ApprovalAsk[] = [];
let onAsk: () => void = () => {};
const ctx: ToolContext = {
  sessionId: "s-push",
  callRoute: createRouteCaller(GIT_ROUTES),
  ask: async (a) => { asked.push(a); onAsk(); return { verdict: "approved" }; },
};
afterEach(() => { onAsk = () => {}; });

const tool = (name: string, args: Record<string, unknown>) => GIT_TOOL_HANDLERS[name]!(ctx, { project: "push", ...args });
const textOf = (r: Record<string, unknown>) => (r.content as Array<{ text: string }>)[0]!.text;
const ok = (r: Record<string, unknown>) => {
  if (r.isError) throw new Error(textOf(r));
  return JSON.parse(textOf(r));
};
const fact = (label: string) => asked.at(-1)!.summary.facts.find((f) => f.label === label)?.value;

/** A teammate's commit on the remote's main, which a forced push would drop. */
function teammateCommit(): string {
  const mate = join(root, "mate");
  git(root, ["clone", "-q", origin, mate]);
  git(mate, ["commit", "-q", "--allow-empty", "-m", "teammate commit"]);
  git(mate, ["push", "-q", "origin", "main"]);
  return git(origin, ["rev-parse", "main"]);
}

describe("a branch whose name starts with +", () => {
  it("is refused by git_branch before any card", async () => {
    const res = await tool("git_branch", { action: "create", name: "+main" });
    expect(res.isError).toBe(true);
    expect(asked).toHaveLength(0);
    expect(git(repo, ["branch", "--list", "+main"])).toBe("");
  });

  it("made outside PPM, is published as itself and never force-pushes main", async () => {
    const remoteMain = teammateCommit();
    git(repo, ["checkout", "-q", "-b", "+main"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "on +main"]);
    const out = ok(await tool("git_sync", { action: "push" }));
    expect(out.published).toEqual({ remote: "origin", branch: "+main" });
    expect(git(origin, ["rev-parse", "main"])).toBe(remoteMain);
    expect(git(origin, ["rev-parse", "refs/heads/+main"])).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(fact("Refspec")).toBe("refs/heads/+main:refs/heads/+main");
  });
});

describe("git_sync push", () => {
  it("goes to the upstream the card names, not to remote.pushDefault", async () => {
    const fork = join(root, "fork.git");
    git(root, ["init", "-q", "--bare", "-b", "main", fork]);
    git(repo, ["remote", "add", "fork", fork]);
    git(repo, ["config", "remote.pushDefault", "fork"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "second"]);
    ok(await tool("git_sync", { action: "push" }));
    expect(git(origin, ["rev-parse", "main"])).toBe(git(repo, ["rev-parse", "HEAD"]));
    expect(git(fork, ["for-each-ref"])).toBe("");
    expect(fact("To")).toBe("branch main on remote origin");
    expect(fact("Refspec")).toBe("refs/heads/main:refs/heads/main");
  });

  it("does not force through a forced remote.<r>.push on a diverged branch", async () => {
    const remoteMain = teammateCommit();
    git(repo, ["fetch", "-q", "origin"]);
    git(repo, ["config", "remote.origin.push", "+refs/heads/main:refs/heads/main"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "diverged"]);
    const res = await tool("git_sync", { action: "push" });
    expect(res.isError).toBe(true);
    expect(fact("Force")).toContain("Never");
    expect(git(origin, ["rev-parse", "main"])).toBe(remoteMain);
  });

  it("pushes only main under push.default = matching", async () => {
    git(repo, ["branch", "other"]);
    git(repo, ["push", "-q", "origin", "other"]);
    const otherOnRemote = git(origin, ["rev-parse", "other"]);
    git(repo, ["checkout", "-q", "other"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "unpushed on other"]);
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["config", "push.default", "matching"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "second"]);
    ok(await tool("git_sync", { action: "push" }));
    expect(git(origin, ["rev-parse", "main"])).toBe(git(repo, ["rev-parse", "main"]));
    expect(git(origin, ["rev-parse", "other"])).toBe(otherOnRemote);
  });

  it("is stale when the upstream is changed while the card waits", async () => {
    git(repo, ["commit", "-q", "--allow-empty", "-m", "second"]);
    const before = git(origin, ["rev-parse", "main"]);
    onAsk = () => { git(repo, ["config", "branch.main.merge", "refs/heads/elsewhere"]); };
    const out = JSON.parse(textOf(await tool("git_sync", { action: "push" })));
    expect(out.outcome).toBe("stale");
    expect(git(origin, ["rev-parse", "main"])).toBe(before);
  });
});

describe("git_discard", () => {
  it("marks every file past the journal's per-discard total as not kept, as the journal then reports", async () => {
    const MB = 1024 * 1024;
    const names = ["f1.bin", "f2.bin", "f3.bin", "f4.bin", "f5.bin", "f6.bin"];
    for (const name of names) writeFileSync(join(repo, name), Buffer.alloc(18 * MB, name.charCodeAt(1)));
    const out = ok(await tool("git_discard", { files: names }));
    expect(out.undo.notKept).toEqual(["f6.bin"]);
    expect(fact("Cannot be undone")).toBe("1 file");
    expect(asked.at(-1)!.summary.body!.text).toContain("f6.bin  (new file — deleted; past the 100 MB one discard keeps — not kept, cannot be undone)");
  });
});

describe("git_commit", () => {
  it("is stale when the staged content changed while the card waited, even with the same line counts", async () => {
    writeFileSync(join(repo, "a.txt"), "two\n");
    ok(await tool("git_stage", { files: ["a.txt"] }));
    const head = git(repo, ["rev-parse", "HEAD"]);
    onAsk = () => {
      writeFileSync(join(repo, "a.txt"), "TWO\n");
      git(repo, ["add", "a.txt"]);
    };
    const out = JSON.parse(textOf(await tool("git_commit", { message: "shown content" })));
    expect(out.outcome).toBe("stale");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
  });
});
