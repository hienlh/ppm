import type { RpcClient } from "../types.ts";

/**
 * `api.ppm.ai` — one prompt, one answer, from Claude or Codex, with no chat session and
 * nothing in the chat list. Each call is one RPC the main thread answers in
 * `src/services/extension-api/extension-ai-handlers.ts` when the call has ended.
 *
 * Aborting `options.signal` rejects at once with an `AbortError` and tells the main thread to
 * stop the provider call (`ai:cancel`), so a cancelled call stops spending too.
 */

export type PpmAiProvider = "claude" | "codex";

export interface PpmAiCompleteRequest {
  provider: PpmAiProvider;
  model: string;
  system: string;
  prompt: string;
  /** The answer must be JSON matching this schema; it comes back parsed in `json`. Keywords
   *  enforced: type (incl. `integer`, lists such as `["string","null"]`), enum, const,
   *  properties, required, additionalProperties, items, min/maxItems, min/maxLength, pattern,
   *  minimum/maximum, exclusiveMinimum/Maximum. Others are ignored. At most 64 KB. A `pattern`
   *  is refused when it could backtrack without bound: over 256 characters, backreferences, a
   *  repeated group holding a repeat or `|`, or more than two unbounded repeats. */
  jsonSchema?: Record<string, unknown>;
  /**
   * Let the model search the web. Claude gets WebSearch only — no WebFetch, so no page it finds
   * can have it send the prompt to a URL. Codex gets live search with its shell and subagents off.
   */
  webSearch?: boolean;
  /** Run on this account; otherwise the usable one with the lowest 5-hour use. */
  accountId?: string;
  /** 5 s to 15 min. Default 3 min, or 10 min with `webSearch`. */
  timeoutMs?: number;
}

export interface PpmAiCompleteResult {
  text: string;
  /** Present when `jsonSchema` was given: the answer, already validated against it. */
  json?: unknown;
  /** Tokens spent, a retry included. */
  inputTokens: number;
  outputTokens: number;
  provider: PpmAiProvider;
  model: string;
  /** Absent when the provider's own sign-in answered (no accounts set up in PPM). */
  accountId?: string;
}

export type PpmAiErrorCode =
  | "BAD_REQUEST" | "NO_ACCOUNT" | "PROVIDER_UNAVAILABLE" | "QUEUE_FULL" | "QUEUE_TIMEOUT"
  | "BAD_JSON" | "RATE_LIMITED" | "TIMEOUT" | "ABORTED" | "PROVIDER_ERROR";

/** A failed call. `name` is `AbortError` for a cancel and `TimeoutError` for a timeout. */
export class PpmAiError extends Error {
  readonly code: PpmAiErrorCode;
  /** The model's raw answer, for `BAD_JSON`. */
  readonly raw?: string;
  constructor(code: PpmAiErrorCode, message: string, raw?: string) {
    super(message);
    this.code = code;
    this.name = code === "ABORTED" ? "AbortError" : code === "TIMEOUT" ? "TimeoutError" : "PpmAiError";
    if (raw !== undefined) this.raw = raw;
  }
}

export interface PpmAi {
  complete(request: PpmAiCompleteRequest, options?: { signal?: AbortSignal }): Promise<PpmAiCompleteResult>;
  /** Model ids per provider; Codex's list is empty when Codex is not set up. */
  listModels(): Promise<Record<PpmAiProvider, string[]>>;
}

/** Kept equal to the main thread's limits (a test pins both). */
export const AI_MIN_TIMEOUT_MS = 5_000;
export const AI_MAX_TIMEOUT_MS = 900_000;
export const AI_DEFAULT_TIMEOUT_MS = 180_000;
export const AI_DEFAULT_WEB_TIMEOUT_MS = 600_000;
export const AI_MAX_QUEUE_WAIT_MS = 60_000;
export const AI_RPC_MARGIN_MS = 15_000;
export const AI_LIST_MODELS_RPC_TIMEOUT_MS = 30_000;

/** How long the worker waits for `ai:complete`: the call, the longest queue wait, a margin. */
export function aiCompleteRpcTimeoutMs(request: Pick<PpmAiCompleteRequest, "timeoutMs" | "webSearch">): number {
  const asked = request.timeoutMs;
  const call = typeof asked === "number" && Number.isFinite(asked)
    ? Math.min(Math.max(asked, AI_MIN_TIMEOUT_MS), AI_MAX_TIMEOUT_MS)
    : request.webSearch ? AI_DEFAULT_WEB_TIMEOUT_MS : AI_DEFAULT_TIMEOUT_MS;
  return call + AI_MAX_QUEUE_WAIT_MS + AI_RPC_MARGIN_MS;
}

type Wire =
  | { ok: true; result: PpmAiCompleteResult }
  | { ok: false; error: { code: PpmAiErrorCode; message: string; raw?: string } };

const cancelled = () => new PpmAiError("ABORTED", "The call was cancelled");

export function createPpmAi(rpc: RpcClient, extensionId: string): PpmAi {
  const cancel = (callId: string) => {
    rpc.request("ai:cancel", { extensionId, callId }).catch(() => {});
  };
  return {
    listModels: () => rpc.requestWithTimeout<Record<PpmAiProvider, string[]>>("ai:listModels", AI_LIST_MODELS_RPC_TIMEOUT_MS),
    complete(request, options = {}) {
      const { signal } = options;
      if (signal?.aborted) return Promise.reject(cancelled());
      const callId = crypto.randomUUID();
      const call = rpc.requestWithTimeout<Wire>("ai:complete", aiCompleteRpcTimeoutMs(request), { extensionId, callId, request })
        .then((wire) => {
          if (wire && wire.ok) return wire.result;
          const error = wire?.error;
          throw new PpmAiError(error?.code ?? "PROVIDER_ERROR", error?.message ?? "No answer", error?.raw);
        }, (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.startsWith("RPC timeout")) throw error;
          cancel(callId);
          throw new PpmAiError("TIMEOUT", message);
        });
      if (!signal) return call;
      return new Promise<PpmAiCompleteResult>((resolve, reject) => {
        const onAbort = () => {
          cancel(callId);
          reject(cancelled());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        call.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
  };
}
