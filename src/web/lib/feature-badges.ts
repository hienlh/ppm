/**
 * Single source of truth for "new" / "beta" feature tags shown in the UI.
 *
 * Add a feature here to tag it everywhere it is rendered with <FeatureBadge id>;
 * delete the line to retire the tag. Nothing else in the codebase hardcodes
 * these labels, so this file is the whole answer to "what is tagged right now?".
 */
export type FeatureBadgeKind = "new" | "beta";

export const FEATURE_BADGES = {
  /** Multi-agent group chat (Teams sidebar tab). */
  teams: "beta",
  /** Floating OS-style file explorer window / mobile sheet, shipped in 0.18.0. */
  "os-explorer": "new",
} as const satisfies Record<string, FeatureBadgeKind>;

export type FeatureBadgeId = keyof typeof FEATURE_BADGES;

/** Returns the tag kind for a feature, or undefined when the feature is untagged. */
export function getFeatureBadge(id: FeatureBadgeId | undefined): FeatureBadgeKind | undefined {
  return id ? FEATURE_BADGES[id] : undefined;
}
