// Pure resolution of the model / effort / thinking query options for the Claude
// Agent SDK. Extracted so the effort enum guard is unit-testable in isolation.
//
// Effort enum is enforced here as defense-in-depth: the CLI rejects any value
// outside this set and crashes the subprocess (notably "extra" — the app UI
// label "Extra" must map to "xhigh" before reaching this layer).

export const VALID_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortValue = (typeof VALID_EFFORT_VALUES)[number];

export interface ModelQueryOverrides {
  model?: string;
  oneMContext?: boolean;
  effort?: string;
  maxThinkingTokens?: number;
}

export interface ModelProviderConfig {
  model?: string;
  context_1m?: boolean;
  effort?: string;
  thinking_budget_tokens?: number;
}

export interface ResolvedModelQueryOptions {
  model?: string;
  effort?: string;
  maxThinkingTokens?: number;
  /** Whether the 1M-context window is active — caller uses this for the betas header. */
  use1m: boolean;
}

/** Resolve per-call overrides against provider config. Per-call wins, else config, else omit. */
export function buildModelQueryOptions(
  opts: ModelQueryOverrides,
  config: ModelProviderConfig,
): ResolvedModelQueryOptions {
  const baseModel = opts.model ?? config.model;
  const use1m = opts.oneMContext ?? config.context_1m ?? false;
  const model =
    baseModel && use1m && !/\[1m\]$/i.test(baseModel) ? `${baseModel}[1m]` : baseModel;

  const effort = opts.effort ?? config.effort;
  if (effort != null && !VALID_EFFORT_VALUES.includes(effort as EffortValue)) {
    throw new Error(
      `invalid effort "${effort}" — must be one of: ${VALID_EFFORT_VALUES.join(", ")}`,
    );
  }

  const maxThinkingTokens = opts.maxThinkingTokens ?? config.thinking_budget_tokens;

  const out: ResolvedModelQueryOptions = { use1m: !!use1m };
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (maxThinkingTokens != null) out.maxThinkingTokens = maxThinkingTokens;
  return out;
}
