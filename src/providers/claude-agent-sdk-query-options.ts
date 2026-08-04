// Pure resolution of the model / effort / thinking query options for the Claude
// Agent SDK. Extracted so the effort enum guard is unit-testable in isolation.
//
// Effort enum is enforced here as defense-in-depth: the CLI rejects any value
// outside this set and crashes the subprocess (notably "extra" — the app UI
// label "Extra" must map to "xhigh" before reaching this layer).

import type { ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

export const VALID_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortValue = (typeof VALID_EFFORT_VALUES)[number];

/**
 * Thinking is a tri-state carried as a nullable integer through config, the DB and
 * the WS protocol:
 *   null / undefined  → inherit: omit the option so the SDK default (adaptive) applies
 *   0                 → explicitly disabled
 *   THINKING_ADAPTIVE → on, model picks its own depth (guided by effort)
 *   > 0               → on with a fixed token budget (older models)
 *
 * The "on" sentinel is negative so it can never collide with a real token count.
 * Collapsing this to a boolean is what silently disabled thinking: an unset session
 * read back as `false`, which round-tripped into an explicit 0.
 */
export const THINKING_ADAPTIVE = -1;

export interface ModelQueryOverrides {
  model?: string;
  oneMContext?: boolean;
  effort?: string;
  thinkingBudget?: number;
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
  thinking?: ThinkingConfig;
  /** Whether the 1M-context window is active — caller uses this for the betas header. */
  use1m: boolean;
}

/**
 * Map the tri-state budget onto the SDK's thinking config.
 *
 * `display` must be requested explicitly: the CLI otherwise omits reasoning content and
 * streams `thinking_delta` frames whose `thinking` field is an empty string carrying only
 * `estimated_tokens`. The model still thinks, but there is nothing to render — which is
 * exactly how the thinking blocks disappeared from chat.
 */
export function resolveThinkingConfig(
  budget: number | null | undefined,
): ThinkingConfig | undefined {
  if (budget === 0) return { type: "disabled" };
  if (budget == null || budget < 0) return { type: "adaptive", display: "summarized" };
  return { type: "enabled", budgetTokens: budget, display: "summarized" };
}

/**
 * On/off state for the UI toggle. Nothing set at either level means the SDK default
 * applies, which is adaptive thinking — so the honest answer is ON, not OFF.
 */
export function isThinkingEnabled(
  sessionBudget: number | null | undefined,
  configBudget: number | null | undefined,
): boolean {
  const effective = sessionBudget ?? configBudget;
  return effective == null ? true : effective !== 0;
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

  const thinking = resolveThinkingConfig(opts.thinkingBudget ?? config.thinking_budget_tokens);

  const out: ResolvedModelQueryOptions = { use1m: !!use1m };
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (thinking) out.thinking = thinking;
  return out;
}
