/**
 * What a Claude one-shot learns about the account it ran on, handed to the account selector the
 * way a chat turn hands it: a 401 is `onAuthError`, a usage limit that names its reset is
 * `onUsageLimit` (a cooldown until that reset), any other rate limit is `onRateLimit`. Without
 * this a refused account keeps the top of the one-shot pick, which orders by usage snapshots
 * that may be minutes old, and every following call is refused the same way.
 *
 * The wording checks are the chat path's own (`claude-agent-sdk.ts`): the SDK sometimes sets
 * `error` on the assistant message and sometimes only writes the API error as its text.
 */
import { accountSelector } from "../services/account-selector.service.ts";
import { parseUsageLimitReset } from "./claude-usage-limit-reset.ts";

export type ClaudeAccountProblem =
  | { kind: "auth" }
  | { kind: "usage"; resetAtMs?: number }
  | { kind: "rate" };

const HIT_LIMIT = /hit your (?:[\w-]+\s+)*limit/i;

function textOf(message: unknown): string {
  const content = (message as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => !!b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function limitProblem(text: string): ClaudeAccountProblem {
  const reset = HIT_LIMIT.test(text) ? parseUsageLimitReset(text) : null;
  return reset ? { kind: "usage", ...(reset.atMs !== undefined && { resetAtMs: reset.atMs }) } : { kind: "rate" };
}

/** The account problem an assistant message reports, or null. */
export function claudeAssistantProblem(message: unknown): ClaudeAccountProblem | null {
  const error = (message as { error?: unknown })?.error;
  const text = textOf(message);
  if (error === "authentication_failed" || /API Error:\s*401\b/i.test(text)) return { kind: "auth" };
  if (error === "rate_limit" || HIT_LIMIT.test(text)) return limitProblem(text);
  return null;
}

/** The account problem a failed result reports (its `errors` and text), or null. */
export function claudeResultProblem(result: unknown, detail: string): ClaudeAccountProblem | null {
  const errors = (result as { errors?: unknown })?.errors;
  const text = `${Array.isArray(errors) ? errors.join(" ") : ""} ${detail}`;
  if (/\b429\b|rate.?limit|overloaded/i.test(text) || HIT_LIMIT.test(text)) return limitProblem(text);
  if (/\b401\b|unauthorized|invalid api key/i.test(text)) return { kind: "auth" };
  return null;
}

/** Tell the selector, so the next pick moves away from a refused account. */
export function recordClaudeAccountProblem(accountId: string, problem: ClaudeAccountProblem): void {
  if (problem.kind === "auth") accountSelector.onAuthError(accountId);
  else if (problem.kind === "usage") accountSelector.onUsageLimit(accountId, problem.resetAtMs);
  else accountSelector.onRateLimit(accountId);
}
