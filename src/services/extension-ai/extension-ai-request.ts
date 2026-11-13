/**
 * The shape of `ppm.ai.complete` as it crosses into the main thread, checked before anything
 * is queued or spent. Everything here arrives from an extension's worker, so nothing is
 * trusted: sizes are bounded, the schema is one the validator can enforce, and the timeout is
 * clamped to the range the worker's own RPC deadline is computed from.
 */
import { OneShotError } from "../../providers/one-shot-error.ts";
import { checkSchema } from "./json-schema-lite.ts";

export type AiProviderId = "claude" | "codex";

export interface AiCompleteRequest {
  provider: AiProviderId;
  model: string;
  system: string;
  prompt: string;
  jsonSchema?: Record<string, unknown>;
  webSearch?: boolean;
  accountId?: string;
  timeoutMs: number;
}

export interface AiCompleteResult {
  text: string;
  json?: unknown;
  inputTokens: number;
  outputTokens: number;
  provider: AiProviderId;
  model: string;
  accountId?: string;
}

export const AI_PROVIDERS: readonly AiProviderId[] = ["claude", "codex"];
export const AI_MAX_PROMPT_CHARS = 400_000;
export const AI_MAX_SCHEMA_BYTES = 64 * 1024;
export const AI_MIN_TIMEOUT_MS = 5_000;
export const AI_MAX_TIMEOUT_MS = 900_000;
export const AI_DEFAULT_TIMEOUT_MS = 180_000;
export const AI_DEFAULT_WEB_TIMEOUT_MS = 600_000;
const MODEL_ID = /^[A-Za-z0-9._:/\-[\]]{1,120}$/;
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,200}$/;

const bad = (message: string) => new OneShotError("BAD_REQUEST", message);

// The extension-id checks are shared by every `api.ppm` area; re-exported for this one's callers.
export { isExtensionId, loggableExtensionId } from "../extension-api/extension-id.ts";

/** The checked request, with its default timeout filled in. Throws `BAD_REQUEST`. */
export function validateAiCompleteRequest(raw: unknown): AiCompleteRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("The request must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== "string" || !AI_PROVIDERS.includes(r.provider as AiProviderId)) {
    throw bad(`provider must be one of ${AI_PROVIDERS.join(", ")}`);
  }
  if (typeof r.model !== "string" || !MODEL_ID.test(r.model)) throw bad("model must be a model id");
  if (typeof r.system !== "string") throw bad("system must be a string");
  if (typeof r.prompt !== "string" || !r.prompt.trim()) throw bad("prompt must be a non-empty string");
  if (r.prompt.length + r.system.length > AI_MAX_PROMPT_CHARS) {
    throw bad(`prompt and system together may hold at most ${AI_MAX_PROMPT_CHARS} characters`);
  }
  if (r.webSearch !== undefined && typeof r.webSearch !== "boolean") throw bad("webSearch must be a boolean");
  if (r.accountId !== undefined && (typeof r.accountId !== "string" || !ACCOUNT_ID.test(r.accountId))) {
    throw bad("accountId must be an account id");
  }
  let jsonSchema: Record<string, unknown> | undefined;
  if (r.jsonSchema !== undefined) {
    let serialised: string;
    try { serialised = JSON.stringify(r.jsonSchema); } catch { throw bad("jsonSchema must be JSON"); }
    if (new TextEncoder().encode(serialised).length > AI_MAX_SCHEMA_BYTES) throw bad("jsonSchema may be at most 64 KB");
    const problem = checkSchema(r.jsonSchema);
    if (problem) throw bad(`jsonSchema cannot be used: ${problem}`);
    jsonSchema = r.jsonSchema as Record<string, unknown>;
  }
  const webSearch = r.webSearch === true;
  let timeoutMs = webSearch ? AI_DEFAULT_WEB_TIMEOUT_MS : AI_DEFAULT_TIMEOUT_MS;
  if (r.timeoutMs !== undefined) {
    if (typeof r.timeoutMs !== "number" || !Number.isFinite(r.timeoutMs)
      || r.timeoutMs < AI_MIN_TIMEOUT_MS || r.timeoutMs > AI_MAX_TIMEOUT_MS) {
      throw bad(`timeoutMs must be between ${AI_MIN_TIMEOUT_MS} and ${AI_MAX_TIMEOUT_MS}`);
    }
    timeoutMs = Math.round(r.timeoutMs);
  }
  return {
    provider: r.provider as AiProviderId,
    model: r.model,
    system: r.system,
    prompt: r.prompt,
    ...(jsonSchema && { jsonSchema }),
    ...(webSearch && { webSearch }),
    ...(typeof r.accountId === "string" && { accountId: r.accountId }),
    timeoutMs,
  };
}
