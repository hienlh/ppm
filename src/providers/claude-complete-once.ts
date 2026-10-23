/**
 * Claude one-shot: one prompt, one answer, no chat session. It runs in a directory of its own
 * (`<ppm dir>/one-shot`) with `settingSources: []` and `persistSession: false`, so no
 * project's CLAUDE.md, settings or `.env` reaches it and nothing lands in the chat list. It
 * authenticates exactly as a turn does, through the env builder the provider passes in.
 *
 * Tools: none, unless `webSearch` asks for WebSearch (which can take several turns). WebFetch
 * is deliberately not offered: pre-approved for any URL, a page found by the search could ask
 * for `https://attacker/?q=<the prompt>` and the prompt would leave the host unasked.
 * WebSearch runs on Anthropic's side and fetches no URL the model names.
 * Structured output: `outputFormat: json_schema`. The SDK delivers it through an end-turn
 * tool call followed by a `structured_output` attachment, i.e. one tool round trip, so a call
 * with a schema gets three turns rather than one. Whether a real model answers within them is
 * not verified here; the caller validates the answer either way and falls back to the text.
 *
 * A refusal for the account (401, usage limit, rate limit) is handed to the account selector
 * as a chat turn hands it, so the next pick moves on.
 */
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { accountSelector } from "../services/account-selector.service.ts";
import { accountService, type AccountWithTokens } from "../services/account.service.ts";
import { getPpmDir } from "../services/ppm-dir.ts";
import type { OneShotInput, OneShotResult } from "../types/chat.ts";
import { OneShotError, type OneShotUsage } from "./one-shot-error.ts";
import {
  claudeAssistantProblem, claudeResultProblem, recordClaudeAccountProblem, type ClaudeAccountProblem,
} from "./claude-one-shot-account-health.ts";

export const CLAUDE_ONE_SHOT_DEFAULT_TIMEOUT_MS = 90_000;
export const CLAUDE_WEB_TOOLS: readonly string[] = ["WebSearch"];
const RATE_LIMIT_TEXT = /hit your (?:[\w-]+\s+)*limit|rate.?limit/i;

/** What the provider lends the one-shot: how to authenticate and how to start the CLI. */
export interface ClaudeOneShotContext {
  buildEnv(account: AccountWithTokens | null): Record<string, string | undefined>;
  cliExecutablePath?: string;
  /** Run the CLI under `node` (a .js entry on Windows). */
  useNode: boolean;
  /** Seam for tests; the SDK's `query` otherwise. */
  runQuery?: typeof query;
}

export function claudeOneShotMaxTurns(input: Pick<OneShotInput, "webSearch" | "jsonSchema">): number {
  if (input.webSearch) return 12;
  return input.jsonSchema ? 3 : 1;
}

/** The query options for one call. Pure, so the exact shape can be asserted. */
export function buildClaudeOneShotOptions(
  input: OneShotInput,
  ctx: Pick<ClaudeOneShotContext, "cliExecutablePath" | "useNode">,
  run: { cwd: string; env: Record<string, string | undefined>; abortController: AbortController },
): Options {
  const tools = input.webSearch ? [...CLAUDE_WEB_TOOLS] : [];
  return {
    ...(ctx.useNode && { executable: "node" as const }),
    ...(ctx.cliExecutablePath && { pathToClaudeCodeExecutable: ctx.cliExecutablePath }),
    cwd: run.cwd,
    model: input.model,
    systemPrompt: input.systemPrompt,
    tools,
    ...(input.webSearch && { allowedTools: [...tools] }),
    ...(input.jsonSchema && { outputFormat: { type: "json_schema" as const, schema: input.jsonSchema } }),
    settingSources: [],
    persistSession: false,
    maxTurns: claudeOneShotMaxTurns(input),
    env: run.env,
    abortController: run.abortController,
  };
}

/** The named account when one is asked for (rotation untouched), else the router's next. */
async function resolveAccount(accountId: string | undefined): Promise<AccountWithTokens | null> {
  if (accountId) {
    const account = await accountService.ensureFreshToken(accountId);
    if (!account) throw new OneShotError("NO_ACCOUNT", "The Claude account's sign-in has expired");
    return account;
  }
  if (!accountSelector.isEnabled()) return null;
  const picked = accountSelector.next();
  if (!picked) throw new Error("No Claude account can take a request right now");
  const account = await accountService.ensureFreshToken(picked.id);
  if (!account) throw new Error("The Claude account's sign-in has expired");
  return account;
}

interface ResponseUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

/** One response's usage in the one-shot's terms; web searches are billed apart from tokens. */
function usageOf(u: ResponseUsage): OneShotUsage {
  const webSearches = u.server_tool_use?.web_search_requests ?? 0;
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    ...(webSearches > 0 && { webSearches }),
  };
}

/** Tokens per API response; the SDK repeats a response's usage on each of its content blocks. */
class UsageTally {
  private byMessage = new Map<string, OneShotUsage>();
  add(message: { id?: string; usage?: ResponseUsage } | undefined): void {
    if (!message?.usage) return;
    this.byMessage.set(message.id ?? `m${this.byMessage.size}`, usageOf(message.usage));
  }
  total(): OneShotUsage {
    let inputTokens = 0, outputTokens = 0, webSearches = 0;
    for (const u of this.byMessage.values()) {
      inputTokens += u.inputTokens; outputTokens += u.outputTokens; webSearches += u.webSearches ?? 0;
    }
    return { inputTokens, outputTokens, ...(webSearches > 0 && { webSearches }) };
  }
}

/** The error a failed result ends the call with, after the account's health is recorded. */
function failure(
  account: AccountWithTokens | null, problem: ClaudeAccountProblem | null, detail: string, usage: OneShotUsage,
): OneShotError {
  if (account && problem) recordClaudeAccountProblem(account.id, problem);
  const text = `Claude did not answer: ${detail.slice(0, 200)}`;
  if (problem?.kind === "auth") return new OneShotError("NO_ACCOUNT", text, { usage });
  if (problem || RATE_LIMIT_TEXT.test(detail)) return new OneShotError("RATE_LIMITED", text, { usage });
  return new OneShotError("PROVIDER_ERROR", text, { usage });
}

export async function claudeCompleteOnce(input: OneShotInput, ctx: ClaudeOneShotContext): Promise<OneShotResult> {
  if (input.signal?.aborted) throw new OneShotError("ABORTED", "The call was cancelled");
  const account = await resolveAccount(input.accountId);
  // A token refresh can take a while; a cancel that landed meanwhile has no listener yet.
  if (input.signal?.aborted) throw new OneShotError("ABORTED", "The call was cancelled");
  const cwd = resolve(getPpmDir(), "one-shot");
  mkdirSync(cwd, { recursive: true });
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abortController.abort(); }, input.timeoutMs ?? CLAUDE_ONE_SHOT_DEFAULT_TIMEOUT_MS);
  const onAbort = () => abortController.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const tally = new UsageTally();
  let problem: ClaudeAccountProblem | null = null;
  try {
    const options = buildClaudeOneShotOptions(input, ctx, { cwd, env: ctx.buildEnv(account), abortController });
    const run = (ctx.runQuery ?? query)({ prompt: input.prompt, options });
    for await (const message of run) {
      if (message.type === "assistant") {
        tally.add(message.message);
        problem ??= claudeAssistantProblem(message);
        continue;
      }
      if (message.type !== "result") continue;
      if (message.subtype !== "success" || message.is_error) {
        const detail = String(message.subtype === "success" ? message.result : message.subtype);
        const usage = tally.total();
        if (message.subtype === "error_max_structured_output_retries") {
          throw new OneShotError("BAD_JSON", "Claude gave no answer that fits the schema", { usage, raw: "" });
        }
        throw failure(account, problem ?? claudeResultProblem(message, detail), detail, usage);
      }
      if (account) accountSelector.onSuccess(account.id);
      const structured = (message as { structured_output?: unknown }).structured_output;
      return {
        text: message.result,
        ...(structured !== undefined && { structured }),
        ...usageOf(message.usage as ResponseUsage),
        ...(account && { accountId: account.id }),
      };
    }
    throw new OneShotError("PROVIDER_ERROR", "Claude ended without an answer", { usage: tally.total() });
  } catch (e) {
    if (input.signal?.aborted) throw new OneShotError("ABORTED", "The call was cancelled", { usage: tally.total() });
    if (timedOut) throw new OneShotError("TIMEOUT", "Claude took too long to answer", { usage: tally.total() });
    throw e;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
