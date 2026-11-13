/**
 * The failure of a one-shot completion, with a machine-readable code. Extensions branch on
 * the code (fall back to another provider, drop a model, give up), so a message alone is not
 * enough: "rate limited" and "no account can answer" lead to different next steps.
 *
 * `usage` carries the tokens a failed call had already spent, so a call cut off by a cancel
 * or a timeout is still logged with its cost.
 */
export type OneShotErrorCode =
  | "BAD_REQUEST"
  | "NO_ACCOUNT"
  | "PROVIDER_UNAVAILABLE"
  | "QUEUE_FULL"
  | "QUEUE_TIMEOUT"
  | "BAD_JSON"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "ABORTED"
  | "PROVIDER_ERROR";

export interface OneShotUsage {
  inputTokens: number;
  outputTokens: number;
  /** Web searches the call ran, billed apart from tokens; absent when there were none. */
  webSearches?: number;
}

export class OneShotError extends Error {
  readonly code: OneShotErrorCode;
  usage?: OneShotUsage;
  /** The model's raw answer, for `BAD_JSON`. */
  raw?: string;

  constructor(code: OneShotErrorCode, message: string, extra?: { usage?: OneShotUsage; raw?: string }) {
    super(message);
    this.name = code === "ABORTED" ? "AbortError" : code === "TIMEOUT" ? "TimeoutError" : "OneShotError";
    this.code = code;
    if (extra?.usage) this.usage = extra.usage;
    if (extra?.raw !== undefined) this.raw = extra.raw;
  }
}

/** The code of any error: a `OneShotError`'s own, an abort's, else `PROVIDER_ERROR`. */
export function oneShotCodeOf(error: unknown): OneShotErrorCode {
  if (error instanceof OneShotError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "ABORTED";
  return "PROVIDER_ERROR";
}

/** Sum two usages; either may be missing. */
export function addUsage(a: OneShotUsage | undefined, b: OneShotUsage | undefined): OneShotUsage {
  const webSearches = (a?.webSearches ?? 0) + (b?.webSearches ?? 0);
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    ...(webSearches > 0 && { webSearches }),
  };
}
