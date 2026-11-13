/**
 * `git_history` and `git_branch` delete against a real repository, through the real routes the
 * UI calls (in-process, by `createRouteCaller(GIT_ROUTES)`): a merge whose `.husky` hook really
 * runs and is named on the card, cherry-pick, revert, tag, a merge stopped on a conflict that is
 * aborted and one that is resolved and continued, a branch delete, and a stale card that writes
 * nothing. Each approved call reaches exactly one write route (one `git:changed`). A merge takes
 * the branch even beside a tag spelled the same, and the card names the hooks an incoming commit
 * adds to the tracked hooks folder.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../src/services/config.service.ts";
import { onGitEvent } from "../../src/services/git-changes/git-events.ts";
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
let marker: string;
let savedProjects: unknown;

const commitFile = (file: string, content: string, message: string) => {
  writeFileSync(join(repo, file), content);
  git(repo, ["add", file]);
  git(repo, ["commit", "-q", "-m", message]);
};

beforeAll(async () => {
  await import("../../src/server/index.ts");
  root = mkdtempSync(join(tmpdir(), "ppm-assistant-git-history-"));
  repo = join(root, "hist");
  marker = join(root, "post-merge-ran");
  mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"], ["core.autocrlf", "false"]]) git(repo, ["config", k!, v!]);
  // A tracked Husky folder: the hook a merged branch could carry, run by the merge itself.
  mkdirSync(join(repo, ".husky"));
  writeFileSync(join(repo, ".husky", "post-merge"), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  git(repo, ["config", "core.hooksPath", ".husky"]);
  commitFile("a.txt", "one\n", "first");
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "hist", path: repo }]);
});

afterAll(() => {
  configService.set("projects", savedProjects as never);
  rmSync(root, { recursive: true, force: true });
});

const call = createRouteCaller(GIT_ROUTES);
const asked: ApprovalAsk[] = [];
let beforeApproving: (() => void) | null = null;
const approve: ToolContext = {
  sessionId: "s-1", callRoute: call,
  ask: async (a) => { asked.push(a); beforeApproving?.(); return { verdict: "approved" }; },
};
const events: string[] = [];
const off = onGitEvent((e) => { if (e.type === "git:changed") events.push(e.type); });
afterAll(off);
afterEach(() => { events.length = 0; asked.length = 0; beforeApproving = null; });

const answer = (r: Record<string, unknown>) => {
  const text = (r.content as Array<{ text: string }>)[0]!.text;
  if (r.isError) throw new Error(text);
  return JSON.parse(text);
};
const history = async (args: Record<string, unknown>) => answer(await GIT_TOOL_HANDLERS.git_history!(approve, { project: "hist", ...args }));
const head = () => git(repo, ["rev-parse", "HEAD"]);
const subject = () => git(repo, ["log", "-1", "--format=%s"]);

describe("git_history on a real repository", () => {
  it("merges a branch after one approval, runs its post-merge hook, and named that hook on the card", async () => {
    git(repo, ["checkout", "-q", "-b", "feat"]);
    commitFile("feat.txt", "feat\n", "add feat");
    git(repo, ["checkout", "-q", "main"]);
    commitFile("main.txt", "main\n", "add main");
    const out = await history({ action: "merge", source: "feat" });
    expect(out).toMatchObject({ done: true, source: "feat", branch: { name: "main" }, operation: null });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.summary.headline).toBe("Merge feat into main");
    expect(asked[0]!.summary.facts.find((f) => f.label === "Hooks")!.value).toBe("Runs this repository's git hooks: post-merge (.husky)");
    expect(existsSync(join(repo, "feat.txt"))).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("cherry-picks, reverts and tags by hash, each with one write", async () => {
    git(repo, ["checkout", "-q", "-b", "side"]);
    commitFile("side.txt", "side\n", "add side");
    const picked = head();
    git(repo, ["checkout", "-q", "main"]);
    await history({ action: "cherry_pick", hash: picked.slice(0, 8) });
    expect(subject()).toBe("add side");
    const copy = head();
    await history({ action: "revert", hash: copy });
    expect(subject()).toBe('Revert "add side"');
    expect(existsSync(join(repo, "side.txt"))).toBe(false);
    await history({ action: "tag", name: "v1", at: copy.slice(0, 10) });
    expect(git(repo, ["rev-parse", "v1^{commit}"])).toBe(copy);
    expect(events).toHaveLength(3);
    // A tag that exists is refused before any card.
    asked.length = 0;
    expect((await GIT_TOOL_HANDLERS.git_history!(approve, { project: "hist", action: "tag", name: "v1" })).isError).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it("stops a merge on a conflict, aborts it, then resolves a second one and continues", async () => {
    git(repo, ["checkout", "-q", "-b", "clash"]);
    commitFile("a.txt", "theirs\n", "clash edit");
    git(repo, ["checkout", "-q", "main"]);
    commitFile("a.txt", "ours\n", "main edit");
    const before = head();

    const stopped = await history({ action: "merge", source: "clash" });
    expect(stopped).toMatchObject({ stopped: true, conflictCount: 1, conflicts: ["a.txt"], operation: { kind: "merge" } });
    const aborted = await history({ action: "abort" });
    expect(aborted).toMatchObject({ done: true, operation: null });
    expect(head()).toBe(before);

    await history({ action: "merge", source: "clash" });
    writeFileSync(join(repo, "a.txt"), "both\n");
    answer(await GIT_TOOL_HANDLERS.git_stage!(approve, { project: "hist", files: ["a.txt"] }));
    const continued = await history({ action: "continue" });
    expect(continued).toMatchObject({ done: true, operation: null });
    expect(git(repo, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ")).toHaveLength(3);
  });

  it("deletes a merged branch and answers with its last commit", async () => {
    const tip = git(repo, ["rev-parse", "feat"]);
    const out = answer(await GIT_TOOL_HANDLERS.git_branch!(approve, { project: "hist", action: "delete", name: "feat" }));
    expect(out).toMatchObject({ deleted: "feat", commit: tip });
    expect(git(repo, ["branch", "--list", "feat"])).toBe("");
    expect(events).toHaveLength(1);
  });

  it("writes nothing when HEAD moved while the card waited", async () => {
    git(repo, ["checkout", "-q", "-b", "late"]);
    commitFile("late.txt", "late\n", "add late");
    git(repo, ["checkout", "-q", "main"]);
    beforeApproving = () => commitFile("moved.txt", "moved\n", "moved meanwhile");
    const out = await GIT_TOOL_HANDLERS.git_history!(approve, { project: "hist", action: "merge", source: "late" });
    expect(JSON.parse((out.content as Array<{ text: string }>)[0]!.text).outcome).toBe("stale");
    expect(existsSync(join(repo, "late.txt"))).toBe(false);
    expect(events).toHaveLength(0);
  });

  it("merges the branch the card showed, not a tag spelled the same", async () => {
    git(repo, ["checkout", "-q", "-b", "rel"]);
    commitFile("rel.txt", "branch\n", "the branch");
    git(repo, ["checkout", "-q", "main"]);
    git(repo, ["checkout", "-q", "-b", "elsewhere"]);
    commitFile("tagged.txt", "tag\n", "the tag");
    git(repo, ["tag", "rel"]);
    git(repo, ["checkout", "-q", "main"]);
    const out = await history({ action: "merge", source: "rel" });
    expect(out).toMatchObject({ done: true, source: "rel" });
    expect(existsSync(join(repo, "rel.txt"))).toBe(true);
    expect(existsSync(join(repo, "tagged.txt"))).toBe(false);
  });

  it("names the hooks the incoming commit adds to the tracked hooks folder, before anything runs", async () => {
    const deny: ToolContext = { sessionId: "s-1", callRoute: call, ask: async (a) => { asked.push(a); return { verdict: "denied", reason: "test" }; } };
    const hook = "#!/bin/sh\nexit 0\n";
    const incoming = () => asked.at(-1)!.summary.facts.find((f) => f.label === "Incoming hooks")?.value;
    // A merge whose source branch brings a commit-msg hook.
    git(repo, ["checkout", "-q", "-b", "hooky"]);
    writeFileSync(join(repo, ".husky", "commit-msg"), hook, { mode: 0o755 });
    git(repo, ["add", ".husky/commit-msg"]);
    git(repo, ["commit", "-q", "--no-verify", "-m", "add a hook"]);
    git(repo, ["checkout", "-q", "main"]);
    expect(existsSync(join(repo, ".husky", "commit-msg"))).toBe(false);
    await GIT_TOOL_HANDLERS.git_history!(deny, { project: "hist", action: "merge", source: "hooky" });
    expect(incoming()).toBe("Added by the incoming commit, then run: commit-msg (.husky)");
    // A picked commit bringing a post-commit hook.
    git(repo, ["checkout", "-q", "-b", "pickme"]);
    writeFileSync(join(repo, ".husky", "post-commit"), hook, { mode: 0o755 });
    git(repo, ["add", ".husky/post-commit"]);
    git(repo, ["commit", "-q", "--no-verify", "-m", "add another hook"]);
    const picked = head();
    git(repo, ["checkout", "-q", "main"]);
    await GIT_TOOL_HANDLERS.git_history!(deny, { project: "hist", action: "cherry_pick", hash: picked });
    expect(incoming()).toBe("Added by the incoming commit, then run: post-commit (.husky)");
    // A revert of a commit that removed a hook brings it back from the parent's tree.
    writeFileSync(join(repo, ".husky", "pre-commit"), hook, { mode: 0o755 });
    git(repo, ["add", ".husky/pre-commit"]);
    git(repo, ["commit", "-q", "--no-verify", "-m", "add pre-commit"]);
    git(repo, ["rm", "-q", ".husky/pre-commit"]);
    git(repo, ["commit", "-q", "--no-verify", "-m", "drop pre-commit"]);
    await GIT_TOOL_HANDLERS.git_history!(deny, { project: "hist", action: "revert", hash: head() });
    expect(incoming()).toBe("Added by the incoming commit, then run: pre-commit (.husky)");
    // The working tree itself holds none of a revert's hooks: only the incoming one is named.
    expect(asked.at(-1)!.summary.facts.find((f) => f.label === "Hooks")).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});
