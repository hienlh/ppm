/**
 * Single source of truth for the Claude models PPM offers.
 *
 * Consumed by config validation, the agent-SDK provider model dropdown,
 * `ppm init`, and the proxy test dialog — adding a model means editing
 * this list only.
 *
 * Invite-only models (e.g. Claude Mythos, Project Glasswing) are omitted on
 * purpose: they would appear as selectable options that fail at request time
 * for accounts without access.
 */

export interface ClaudeModelOption {
  /** Model ID sent to the Claude API / Agent SDK. */
  value: string;
  /** Short label for UI dropdowns. */
  label: string;
  /** Capability hint shown next to the label in the `ppm init` prompt. */
  hint: string;
}

/** Ordered newest/most-capable first; the first entry is not automatically the default. */
export const CLAUDE_MODELS: readonly ClaudeModelOption[] = [
  { value: "claude-opus-5", label: "Claude Opus 5", hint: "most powerful" },
  { value: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "flagship" },
  { value: "claude-fable-5", label: "Claude Fable 5", hint: "flagship" },
  { value: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "powerful" },
  { value: "claude-opus-4-7", label: "Claude Opus 4.7", hint: "powerful" },
  { value: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "powerful" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "fast" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "fast" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "cheap" },
];

/** Model IDs accepted by config validation. */
export const CLAUDE_MODEL_IDS: readonly string[] = CLAUDE_MODELS.map((m) => m.value);

/** Label used by the `ppm init` model prompt, e.g. "Claude Opus 5 (most powerful)". */
export function claudeModelInitName(model: ClaudeModelOption): string {
  return `${model.label} (${model.hint})`;
}
