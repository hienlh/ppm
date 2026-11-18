/**
 * Draft a commit message from what is staged (`git diff --cached --stat` + `git diff --cached`),
 * through `completeOnce` of the provider Settings names as the default — Claude on its
 * lightweight model (`haiku`), Codex on its configured model or its own default. Never commits.
 *
 * The provider is the one picked or none: a default that is not registered, or cannot answer a
 * one-shot, is refused rather than handed to Claude, whose quota the person did not choose to
 * spend. Secrets in the diff are redacted before it leaves the machine.
 */
import { providerRegistry } from "../providers/registry.ts";
import { redactLogText } from "../shared/log-redact.ts";
import type { OneShotInput } from "../types/chat.ts";
import { configService } from "./config.service.ts";
import { pickOneShotAccount } from "./extension-ai/extension-ai-account.ts";
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

/** Secrets only: paths, emails and ids in a diff are the code itself. */
const REDACT_SECRETS = { home: false, email: false, chats: false } as const;

export class GitCommitMessageError extends Error {
  readonly status: 409 | 502;
  constructor(message: string, status: 409 | 502) {
    super(message);
    this.name = "GitCommitMessageError";
    this.status = status;
  }
}

type CompleteOnce = (input: OneShotInput) => Promise<{ text: string }>;

interface OneShotPick {
  completeOnce: CompleteOnce;
  model: string;
  accountId?: string;
}

/** The default provider's one-shot, with the model and account it runs on. Never another provider. */
async function resolveOneShot(): Promise<OneShotPick> {
  const ai = configService.get("ai");
  const id = ai.default_provider;
  if (id !== "claude" && id !== "codex") {
    const name = providerRegistry.get(id)?.name ?? id;
    throw new GitCommitMessageError(
      `${name} cannot draft a commit message. Make Claude or Codex the default provider in Settings.`, 409,
    );
  }
  const provider = providerRegistry.get(id) as { completeOnce?: CompleteOnce } | undefined;
  if (typeof provider?.completeOnce !== "function") {
    throw new GitCommitMessageError(`${id === "codex" ? "Codex" : "Claude"} is not available right now`, 502);
  }
  // A Claude model id set for Codex is not one Codex can run; "" leaves the pick to Codex.
  const codexModel = ai.providers.codex?.model;
  const model = id === "claude" ? COMMIT_MESSAGE_MODEL : codexModel && !/^claude/i.test(codexModel) ? codexModel : "";
  let accountId: string | undefined;
  try {
    accountId = (await pickOneShotAccount(id)).accountId;
  } catch (e) {
    throw new GitCommitMessageError((e as Error).message, 502);
  }
  return { completeOnce: provider.completeOnce.bind(provider), model, ...(accountId ? { accountId } : {}) };
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

    const stat = redactLogText(toDisplay(statRes.stdout), REDACT_SECRETS).trim();
    const files = redactLogText(toDisplay(filesRes.stdout), REDACT_SECRETS).trim();
    const diff = redactLogText(toDisplay(diffRes.stdout), REDACT_SECRETS);

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

    const { completeOnce, model, accountId } = await resolveOneShot();
    let answer: { text: string };
    try {
      answer = await completeOnce({
        prompt,
        model,
        systemPrompt: SYSTEM_PROMPT,
        timeoutMs: COMMIT_MESSAGE_TIMEOUT_MS,
        ...(accountId ? { accountId } : {}),
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
