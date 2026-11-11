/**
 * Draft a commit message from what is staged (`git diff --cached --stat` + `git diff --cached`),
 * through `completeOnce` on the lightweight model (`haiku`). Never commits.
 */
import { providerRegistry } from "../providers/registry.ts";
import { runGit, toDisplay } from "./git-hunks/git-hunks.service.ts";

export const MAX_STAGED_DIFF_BYTES = 60 * 1024;
export const COMMIT_MESSAGE_MODEL = "haiku";
export const COMMIT_MESSAGE_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = [
  "You write concise, accurate git commit messages from a staged diff.",
  "Follow conventional commit style when appropriate (e.g. feat:, fix:, refactor:, docs:, test:, chore:).",
  "Keep the subject line under 72 characters. Add a short body after a blank line only when the diff needs explanation.",
  "Reply with the commit message only — no markdown code fences, no quotes, and no surrounding commentary.",
].join(" ");

export class GitCommitMessageError extends Error {
  readonly status: 409 | 502;
  constructor(message: string, status: 409 | 502) {
    super(message);
    this.name = "GitCommitMessageError";
    this.status = status;
  }
}

type CompleteOnce = (input: {
  prompt: string;
  model: string;
  systemPrompt?: string;
  timeoutMs?: number;
}) => Promise<{ text: string }>;

function resolveCompleteOnce(): CompleteOnce {
  let defaultProvider: { completeOnce?: CompleteOnce } | undefined;
  try {
    defaultProvider = providerRegistry.getDefault() as { completeOnce?: CompleteOnce };
  } catch {
    defaultProvider = undefined;
  }
  if (typeof defaultProvider?.completeOnce === "function") {
    return defaultProvider.completeOnce.bind(defaultProvider);
  }
  const claude = providerRegistry.get("claude") as { completeOnce?: CompleteOnce } | undefined;
  if (typeof claude?.completeOnce === "function") {
    return claude.completeOnce.bind(claude);
  }
  throw new GitCommitMessageError("The AI provider is not available", 502);
}

function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) {
    text = fence[1]!.trim();
  }
  return text;
}

export const gitCommitMessageService = {
  async generate(repoPath: string): Promise<{ message: string }> {
    const [statRes, filesRes, diffRes] = await Promise.all([
      runGit(repoPath, ["diff", "--cached", "--stat"]),
      runGit(repoPath, ["diff", "--cached", "--name-status"]),
      runGit(repoPath, ["diff", "--cached"]),
    ]);
    if (diffRes.exitCode !== 0) {
      throw new Error(diffRes.stderr.trim() || `git diff --cached exited with ${diffRes.exitCode}`);
    }

    const stat = toDisplay(statRes.stdout).trim();
    const files = toDisplay(filesRes.stdout).trim();
    const diff = toDisplay(diffRes.stdout);

    if (!diff.trim() && !stat && !files) {
      throw new GitCommitMessageError("Nothing is staged", 409);
    }

    const diffBytes = Buffer.from(diff, "utf8");
    const truncated = diffBytes.length > MAX_STAGED_DIFF_BYTES;
    const diffBody = truncated
      ? `${diffBytes.subarray(0, MAX_STAGED_DIFF_BYTES).toString("utf8")}\n... (staged diff truncated at 60 KB)`
      : diff;

    const prompt = [
      "Write a git commit message for these staged changes.",
      "",
      "Staged files:",
      files || stat,
      "",
      "Diff stat:",
      stat,
      "",
      "Staged diff:",
      diffBody,
    ].join("\n");

    const completeOnce = resolveCompleteOnce();
    let answer: { text: string };
    try {
      answer = await completeOnce({
        prompt,
        model: COMMIT_MESSAGE_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
      });
    } catch (e) {
      if (e instanceof GitCommitMessageError) throw e;
      throw new GitCommitMessageError((e as Error).message || "Failed to generate commit message", 502);
    }

    const message = cleanCommitMessage(answer.text ?? "");
    if (!message) {
      throw new GitCommitMessageError("The AI returned an empty commit message", 502);
    }
    return { message };
  },
};
