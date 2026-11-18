import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { providerRegistry } from "../../../src/providers/registry.ts";
import type { AIProvider } from "../../../src/providers/provider.interface.ts";
import { configService } from "../../../src/services/config.service.ts";
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

  it("never shows the AI a secret from the staged diff", async () => {
    const anthropicKey = "sk-ant-api03-Zq8vT2mLr5Xw9Kd3Hf7Jp1Nb6Yc4Ue0Gs";
    const githubToken = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const dbPassword = "hunter2-very-secret";
    writeFileSync(join(repo, "config.ts"), [
      `export const ANTHROPIC_KEY = "${anthropicKey}";`,
      `export const GH = "${githubToken}";`,
      `export const DB = "postgres://app:${dbPassword}@db.internal/app";`,
      "",
    ].join("\n"));
    git(repo, "add", "config.ts");

    const spy = spyCompleteOnce(async () => ({ text: "chore: add config", costUsd: 0, inputTokens: 1, outputTokens: 1 }));
    await gitCommitMessageService.generate(repo);

    const prompt = spy.mock.calls[0]![0].prompt;
    expect(prompt).toContain("config.ts");
    expect(prompt).toContain("[REDACTED]");
    for (const secret of [anthropicKey, githubToken, dbPassword]) expect(prompt).not.toContain(secret);
  });

  describe("the provider is the default one, never Claude in its place", () => {
    const savedAi = structuredClone(configService.get("ai"));
    const providers = (providerRegistry as unknown as { providers: Map<string, AIProvider> }).providers;

    function useDefault(id: string, codexModel?: string): void {
      const ai = configService.get("ai");
      configService.set("ai", {
        ...ai,
        default_provider: id,
        providers: {
          ...ai.providers,
          [id]: { ...ai.providers[id], type: "cli", ...(id === "codex" && codexModel ? { model: codexModel } : {}) },
        },
      });
      restores.push(() => configService.set("ai", structuredClone(savedAi)));
    }

    function registerFake(id: string, name: string, completeOnce?: (input: { prompt: string; model: string }) => Promise<{ text: string }>) {
      const before = providers.get(id);
      const fake = { id, name, ...(completeOnce ? { completeOnce } : {}) } as unknown as AIProvider;
      providers.set(id, fake);
      restores.push(() => (before ? providers.set(id, before) : providers.delete(id)));
    }

    function stageReadme(): void {
      writeFileSync(join(repo, "README.md"), "# Demo\n\nCodex default.\n");
      git(repo, "add", "README.md");
    }

    it("drafts with Codex's completeOnce when Codex is the default, on its own default model", async () => {
      useDefault("codex");
      const claude = spyCompleteOnce(async () => ({ text: "chore: from claude", costUsd: 0, inputTokens: 0, outputTokens: 0 }));
      const calls: Array<{ prompt: string; model: string }> = [];
      registerFake("codex", "Codex", async (input) => {
        calls.push(input);
        return { text: "docs: from codex" };
      });
      stageReadme();

      const res = await createApp(repo).request("/git/commit-message", { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, data: { message: "docs: from codex" } });
      expect(claude).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.model).toBe("");
      expect(calls[0]!.prompt).toContain("+Codex default.");
    });

    it("passes the Codex model set in Settings", async () => {
      useDefault("codex", "gpt-6-mini");
      spyCompleteOnce(async () => ({ text: "chore: from claude", costUsd: 0, inputTokens: 0, outputTokens: 0 }));
      const calls: Array<{ model: string }> = [];
      registerFake("codex", "Codex", async (input) => {
        calls.push(input);
        return { text: "docs: from codex" };
      });
      stageReadme();

      await gitCommitMessageService.generate(repo);
      expect(calls.map((c) => c.model)).toEqual(["gpt-6-mini"]);
    });

    it("answers 502 when Codex is the default but not available, without asking Claude", async () => {
      useDefault("codex");
      const before = providers.get("codex");
      providers.delete("codex");
      restores.push(() => { if (before) providers.set("codex", before); });
      const claude = spyCompleteOnce(async () => ({ text: "chore: from claude", costUsd: 0, inputTokens: 0, outputTokens: 0 }));
      stageReadme();

      const res = await createApp(repo).request("/git/commit-message", { method: "POST" });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: "Codex is not available right now" });
      expect(claude).not.toHaveBeenCalled();
    });

    it("answers 409 when the default provider cannot draft one, without asking Claude", async () => {
      registerFake("antigravity", "Antigravity");
      useDefault("antigravity");
      const claude = spyCompleteOnce(async () => ({ text: "chore: from claude", costUsd: 0, inputTokens: 0, outputTokens: 0 }));
      stageReadme();

      const res = await createApp(repo).request("/git/commit-message", { method: "POST" });
      expect(res.status).toBe(409);
      const body = await res.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Antigravity cannot draft a commit message");
      expect(claude).not.toHaveBeenCalled();
    });
  });
});
