/**
 * `ppm.ai.complete` on the main thread: validate, wait for a slot in the extension's lane,
 * pick the account, run the provider's one-shot, and when a schema was given, make sure the
 * answer is JSON that fits it — the provider's native structured answer if it gave one, else
 * the first JSON value in the text. An answer that does not fit is asked for once more with
 * the problems appended; a second miss is `BAD_JSON` with the raw text attached.
 *
 * The whole call, retry included, shares one deadline (`timeoutMs`), counted from the moment
 * the slot is granted. Aborting `signal` stops the provider call itself. Every call ends with
 * one log line — extension, provider, model, account, time, tokens, web searches, outcome —
 * never the prompt.
 *
 * The extension id comes from the worker, which every extension shares, so it is checked twice
 * before it names a queue or reaches the log: it must look like an extension id, and it must
 * name an installed, enabled extension. The limiter's total cap is what bounds an extension
 * that borrows another's id.
 */
import { addUsage, OneShotError, oneShotCodeOf, type OneShotUsage } from "../../providers/one-shot-error.ts";
import { providerRegistry } from "../../providers/registry.ts";
import type { OneShotInput, OneShotResult } from "../../types/chat.ts";
import { createLogger } from "../logger.ts";
import { pickOneShotAccount, type PickedAccount } from "./extension-ai-account.ts";
import { ExtensionAiLimiter } from "./extension-ai-limiter.ts";
import {
  isExtensionId, loggableExtensionId, validateAiCompleteRequest,
  type AiCompleteRequest, type AiCompleteResult, type AiProviderId,
} from "./extension-ai-request.ts";
import { getExtensionById } from "../db.service.ts";
import { extractJson } from "./json-extract.ts";
import { formatProblems, validateJson } from "./json-schema-lite.ts";

const log = createLogger("extension-ai");
const RAW_ANSWER_LIMIT = 64 * 1024;

export interface OneShotProvider {
  completeOnce(input: OneShotInput): Promise<OneShotResult>;
}

export interface ExtensionAiDeps {
  limiter: ExtensionAiLimiter;
  provider(id: AiProviderId): OneShotProvider | undefined;
  pickAccount(provider: AiProviderId, explicit?: string): PickedAccount | Promise<PickedAccount>;
  /** Whether `id` names an extension allowed to call: installed and enabled. */
  isKnownExtension(id: string): boolean;
  now(): number;
}

export const extensionAiLimiter = new ExtensionAiLimiter();

export const defaultExtensionAiDeps: ExtensionAiDeps = {
  limiter: extensionAiLimiter,
  provider: (id) => {
    const p = providerRegistry.get(id) as Partial<OneShotProvider> | undefined;
    return p && typeof p.completeOnce === "function" ? p as OneShotProvider : undefined;
  },
  pickAccount: pickOneShotAccount,
  isKnownExtension: (id) => getExtensionById(id)?.enabled === 1,
  now: () => Date.now(),
};

type Spent = { usage: OneShotUsage; accountId?: string };

/** One provider call whose tokens are added to `spent`, also when it fails part-way. */
async function callProvider(provider: OneShotProvider, input: OneShotInput, spent: Spent): Promise<OneShotResult> {
  try {
    const result = await provider.completeOnce(input);
    spent.usage = addUsage(spent.usage, result);
    return result;
  } catch (error) {
    if (error instanceof OneShotError) {
      spent.usage = addUsage(spent.usage, error.usage);
      error.usage = spent.usage;
    }
    throw error;
  }
}

/** What the schema asks for at the top, so the extractor can skip a stray "[1]". */
function topKind(schema: Record<string, unknown>): "object" | "array" | undefined {
  return schema.type === "object" || schema.type === "array" ? schema.type : undefined;
}

function schemaInstructions(system: string, schema: Record<string, unknown>): string {
  const rule = `Answer with one JSON value that matches this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`;
  return system.trim() ? `${system}\n\n${rule}` : rule;
}

/** The answer's JSON and why it does not fit, or no problem. */
function readAnswer(result: OneShotResult, schema: Record<string, unknown>): { json?: unknown; problem?: string } {
  const extracted = result.structured !== undefined ? { found: true as const, value: result.structured } : extractJson(result.text, topKind(schema));
  if (!extracted.found) return { problem: "the answer held no JSON" };
  const problems = validateJson(extracted.value, schema);
  return problems.length ? { json: extracted.value, problem: formatProblems(problems) } : { json: extracted.value };
}

async function runWithSchema(
  request: AiCompleteRequest, provider: OneShotProvider, base: OneShotInput, schema: Record<string, unknown>,
  deadline: number, deps: ExtensionAiDeps, spent: Spent,
): Promise<{ result: OneShotResult; json: unknown }> {
  let prompt = request.prompt;
  let lastRaw = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const timeoutMs = deadline - deps.now();
    if (timeoutMs <= 0) throw new OneShotError("TIMEOUT", "The call ran out of time", { usage: spent.usage });
    let result: OneShotResult;
    let problem: string | undefined;
    let json: unknown;
    try {
      result = await callProvider(provider, { ...base, prompt, timeoutMs }, spent);
      ({ json, problem } = readAnswer(result, schema));
    } catch (error) {
      if (oneShotCodeOf(error) !== "BAD_JSON") throw error;
      result = { text: (error as OneShotError).raw ?? "", inputTokens: 0, outputTokens: 0 };
      problem = (error as OneShotError).message;
    }
    if (!problem) return { result, json };
    lastRaw = result.text;
    prompt = `${request.prompt}\n\nYour previous answer did not fit the required JSON Schema: ${problem}. `
      + "Answer again with only the corrected JSON.";
  }
  throw new OneShotError("BAD_JSON", "The answer did not fit the JSON Schema after one retry", {
    usage: spent.usage, raw: lastRaw.slice(0, RAW_ANSWER_LIMIT),
  });
}

async function run(request: AiCompleteRequest, signal: AbortSignal, deps: ExtensionAiDeps, spent: Spent): Promise<AiCompleteResult> {
  const provider = deps.provider(request.provider);
  if (!provider) throw new OneShotError("PROVIDER_UNAVAILABLE", `The ${request.provider} provider is not available`);
  const picked = await deps.pickAccount(request.provider, request.accountId);
  spent.accountId = picked.accountId;
  const deadline = deps.now() + request.timeoutMs;
  const schema = request.jsonSchema;
  const base: OneShotInput = {
    prompt: request.prompt,
    systemPrompt: schema ? schemaInstructions(request.system, schema) : request.system,
    model: request.model,
    timeoutMs: request.timeoutMs,
    ...(schema && { jsonSchema: schema }),
    ...(request.webSearch && { webSearch: true }),
    ...(picked.accountId && { accountId: picked.accountId }),
    signal,
  };
  let result: OneShotResult;
  let json: unknown;
  if (schema) ({ result, json } = await runWithSchema(request, provider, base, schema, deadline, deps, spent));
  else result = await callProvider(provider, base, spent);
  const accountId = result.accountId ?? picked.accountId;
  return {
    text: result.text,
    ...(schema && { json }),
    inputTokens: spent.usage.inputTokens,
    outputTokens: spent.usage.outputTokens,
    provider: request.provider,
    model: request.model,
    ...(accountId && { accountId }),
  };
}

/** One extension call, from the raw RPC payload to the answer. Throws `OneShotError`s. */
export async function completeForExtension(
  extensionId: string, raw: unknown, signal: AbortSignal, deps: ExtensionAiDeps = defaultExtensionAiDeps,
): Promise<AiCompleteResult> {
  const startedAt = deps.now();
  if (!isExtensionId(extensionId) || !deps.isKnownExtension(extensionId)) {
    log.warn(`ai.complete refused: unknown extension ${loggableExtensionId(extensionId)}`);
    throw new OneShotError("BAD_REQUEST", "extensionId does not name an installed, enabled extension");
  }
  const request = validateAiCompleteRequest(raw);
  const spent: Spent = { usage: { inputTokens: 0, outputTokens: 0 } };
  let outcome = "ok";
  try {
    const release = await deps.limiter.acquire(extensionId, signal);
    try {
      return await run(request, signal, deps, spent);
    } finally {
      release();
    }
  } catch (error) {
    outcome = oneShotCodeOf(error);
    if (error instanceof OneShotError) throw error;
    throw new OneShotError("PROVIDER_ERROR", (error as Error)?.message ?? String(error), { usage: spent.usage });
  } finally {
    log.info(`ai.complete ext=${extensionId} provider=${request.provider} model=${request.model} `
      + `account=${spent.accountId ?? "default"} ms=${deps.now() - startedAt} `
      + `in=${spent.usage.inputTokens} out=${spent.usage.outputTokens} searches=${spent.usage.webSearches ?? 0} outcome=${outcome}`);
  }
}
