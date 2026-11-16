import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { buildPrQuery, mapPullRequest, PR_BATCH, readPrStates } from "../../../../../src/services/ppm-tasks/link-state/github-pr-link-state-reader.ts";
import { runGh, type GhRun, type GhRunner } from "../../../../../src/services/ppm-tasks/link-state/gh-cli-runner.ts";

const ok = (stdout: unknown): GhRun => ({ code: 0, stdout: JSON.stringify(stdout), stderr: "", missing: false, timedOut: false });

const PR = {
  state: "OPEN", isDraft: false, title: "Fix pension rounding", author: { login: "dev1" }, reviewDecision: "CHANGES_REQUESTED",
  reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
    { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
  ] } } } }] },
};

describe("mapPullRequest", () => {
  it("maps state, checks, review and threads", () => {
    expect(mapPullRequest(PR)).toEqual({
      state: "open",
      checks: { total: 4, failing: 2, pending: 1, failingNames: ["unit", "ci/legacy"] },
      reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2, author: "dev1", title: "Fix pension rounding",
    });
    expect(mapPullRequest({ ...PR, state: "MERGED" })!.state).toBe("merged");
    expect(mapPullRequest({ ...PR, isDraft: true })!.state).toBe("draft");
    expect(mapPullRequest({ state: "CLOSED", title: "x" })!.checks).toEqual({ total: 0, failing: 0, pending: 0, failingNames: [] });
    expect(mapPullRequest(null)).toBeNull();
  });
});

describe("buildPrQuery", () => {
  it("passes owner, repo and number as variables, never in the query text", () => {
    const { query, args } = buildPrQuery([{ owner: "acme", repo: "app", number: 12 }]);
    expect(query).not.toContain("acme");
    expect(args).toEqual(["api", "graphql", "-f", `query=${query}`, "-f", "o0=acme", "-f", "r0=app", "-F", "n0=12"]);
  });
});

describe("readPrStates", () => {
  it("asks once per 20 PRs and maps each alias", async () => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push([...args]);
      const n = args.filter((a) => a.startsWith("n")).length;
      return ok({ data: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { pullRequest: { ...PR, title: `t${i}` } }])) });
    };
    const refs = Array.from({ length: 25 }, (_, i) => `acme/app#${i + 1}`);
    const out = await readPrStates(refs, gh);
    expect(calls).toHaveLength(2);
    expect(PR_BATCH).toBe(20);
    expect(out.get("acme/app#1")!.state!.title).toBe("t0");
    expect(out.get("acme/app#25")!.state!.title).toBe("t4");
  });

  it("a PR GitHub does not answer reads as not found; a bad ref never reaches gh", async () => {
    const gh: GhRunner = async () => ({ code: 1, stdout: JSON.stringify({ data: { p0: { pullRequest: null } }, errors: [{ message: "not found" }] }), stderr: "gh: not found", missing: false, timedOut: false });
    const out = await readPrStates(["acme/app#9", "not a pr"], gh);
    expect(out.get("acme/app#9")).toEqual({ state: null, error: "PR not found or no access" });
    expect(out.get("not a pr")).toEqual({ state: null, error: "not a PR reference" });
  });

  it("gh missing or signed out reads as gh not available", async () => {
    const missing: GhRunner = async () => ({ code: null, stdout: "", stderr: "Executable not found", missing: true, timedOut: false });
    expect((await readPrStates(["acme/app#1"], missing)).get("acme/app#1")).toEqual({ state: null, error: "gh not available" });
    const signedOut: GhRunner = async () => ({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login", missing: false, timedOut: false });
    expect((await readPrStates(["acme/app#1"], signedOut)).get("acme/app#1")!.error).toBe("gh not available");
  });
});

describe("runGh", () => {
  it("answers a failed run, never throws, when gh is not on PATH", async () => {
    // Bun resolves binaries from the PATH the process started with, so the missing `gh` is
    // reproduced in a child started without one.
    const runner = resolve(import.meta.dir, "../../../../../src/services/ppm-tasks/link-state/gh-cli-runner.ts").replace(/\\/g, "/");
    const script = `const { runGh } = await import(${JSON.stringify(runner)}); console.log(JSON.stringify(await runGh(["--version"])));`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: "/nonexistent" }, stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    const run = JSON.parse(out.trim()) as GhRun;
    expect(run.missing).toBe(true);
    expect(run.code).toBeNull();
  });

  it("is a value even when gh runs", async () => {
    const run = await runGh(["--version"]);
    expect(typeof run.missing).toBe("boolean");
  });
});
