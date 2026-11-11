import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { gitRoutes } from "../../../src/server/routes/git.ts";
import { onGitEvent, type GitEvent } from "../../../src/services/git-changes/git-events.ts";
import {
  COMMIT_MESSAGE_MODEL,
  GitCommitMessageError,
  MAX_STAGED_DIFF_BYTES,
  gitCommitMessageService,
} from "../../../src/services/git-commit-message.service.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

let repo = "";
const restores: Array<() => void> = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "PPM Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# Demo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "initial commit");
}

function createApp(projectPath: string) {
  const app = new Hono<Env>();
  app.use("/*", async (c, next) => {
    c.set("projectPath", projectPath);
    c.set("projectName", "demo");
    await next();
  });
  app.route("/git", gitRoutes);
  return app;
}

function spyCompleteOnce(impl: (input: { prompt: string; model: string; systemPrompt?: string }) => Promise<{ text: string; costUsd: number; inputTokens: number; outputTokens: number }>) {
  const claude = providerRegistry.get("claude") as unknown as {
    completeOnce: (input: { prompt: string; model: string; systemPrompt?: string }) => Promise<{ text: string; costUsd: number; inputTokens: number; outputTokens: number }>;
  };
  const spy = spyOn(claude, "completeOnce").mockImplementation(impl);
  restores.push(() => spy.mockRestore());
  return spy;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ppm-commit-msg-"));
  initRepo(repo);
});

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  rmSync(repo, { recursive: true, force: true });
});

describe("gitCommitMessageService and POST /git/commit-message", () => {
  it("returns 409 Nothing is staged when nothing is staged, even with unstaged edits", async () => {
    writeFileSync(join(repo, "README.md"), "# Changed unstaged\n");
    writeFileSync(join(repo, "untracked.txt"), "hello\n");
    const spy = spyCompleteOnce(async () => ({
      text: "chore: should not be called",
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }));

    await expect(gitCommitMessageService.generate(repo)).rejects.toEqual(
      new GitCommitMessageError("Nothing is staged", 409),
    );
    expect(spy).not.toHaveBeenCalled();

    const res = await createApp(repo).request("/git/commit-message", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "Nothing is staged" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("drafts a commit message from git diff --cached --stat and diff, using the lightweight model, without committing", async () => {
    const headBefore = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "README.md"), "# Demo\n\nAdded phone layout docs.\n");
    git(repo, "add", "README.md");

    const spy = spyCompleteOnce(async () => ({
      text: "  docs: document phone layout\n",
      costUsd: 0.0001,
      inputTokens: 50,
      outputTokens: 8,
    }));

    const events: GitEvent[] = [];
    restores.push(onGitEvent((e) => events.push(e)));

    const res = await createApp(repo).request("/git/commit-message", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { message: "docs: document phone layout" },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const callArg = spy.mock.calls[0]![0];
    expect(callArg.model).toBe(COMMIT_MESSAGE_MODEL);
    expect(callArg.prompt).toContain("README.md");
    expect(callArg.prompt).toContain("+Added phone layout docs.");

    // Never commits by itself; staged changes stay staged and no write event is broadcast.
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("README.md");
    expect(events).toEqual([]);
  });

  it("truncates staged diffs larger than 60 KB while keeping the full staged file list", async () => {
    const bigContent = `${"line-of-staged-code-0123456789abcdef\n".repeat(2200)}`;
    writeFileSync(join(repo, "alpha-big.ts"), bigContent);
    writeFileSync(join(repo, "zeta-tail.ts"), "export const tail = 1;\n");
    git(repo, "add", "alpha-big.ts", "zeta-tail.ts");

    const rawDiff = git(repo, "diff", "--cached");
    expect(Buffer.byteLength(rawDiff, "utf8")).toBeGreaterThan(MAX_STAGED_DIFF_BYTES);

    const spy = spyCompleteOnce(async () => ({
      text: "```text\nfeat: add alpha-big and zeta-tail\n```",
      costUsd: 0,
      inputTokens: 100,
      outputTokens: 10,
    }));

    const result = await gitCommitMessageService.generate(repo);
    expect(result).toEqual({ message: "feat: add alpha-big and zeta-tail" });

    const prompt = spy.mock.calls[0]![0].prompt;
    // Both files appear via --stat / file list even though the diff is cut at 60 KB.
    expect(prompt).toContain("alpha-big.ts");
    expect(prompt).toContain("zeta-tail.ts");
    expect(prompt).toContain("truncated");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(Buffer.byteLength(rawDiff, "utf8"));
  });

  it("returns 502 with the provider error when the AI call fails", async () => {
    writeFileSync(join(repo, "README.md"), "# Failing AI\n");
    git(repo, "add", "README.md");

    spyCompleteOnce(async () => {
      throw new Error("No Claude account can take a request right now");
    });

    const res = await createApp(repo).request("/git/commit-message", { method: "POST" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      ok: false,
      error: "No Claude account can take a request right now",
    });
  });

  it("scopes to a nested repository via ?repo=", async () => {
    const container = mkdtempSync(join(tmpdir(), "ppm-commit-container-"));
    restores.push(() => rmSync(container, { recursive: true, force: true }));
    const subRepo = join(container, "packages", "mobile");
    initRepo(subRepo);
    writeFileSync(join(subRepo, "README.md"), "# Mobile nested\n");
    git(subRepo, "add", "README.md");

    spyCompleteOnce(async () => ({
      text: "feat(mobile): update nested readme",
      costUsd: 0,
      inputTokens: 10,
      outputTokens: 6,
    }));

    const res = await createApp(container).request(
      `/git/commit-message?repo=${encodeURIComponent(subRepo)}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { message: "feat(mobile): update nested readme" },
    });
  });
});
