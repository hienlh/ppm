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
  /** PPM Assistant — the global chat that runs each project's manager chat. */
  assistant: "new",
  /** Remote Desktop — stream + control the host desktop in a floating window. */
  "remote-desktop": "beta",
  /** Design mode (Designs sidebar tab): design chat beside a live canvas, shipped in 0.23.0. */
  designs: "new",
  /** Android emulator — start an AVD and control its screen from the browser. */
  android: "beta",
} as const satisfies Record<string, FeatureBadgeKind>;

export type FeatureBadgeId = keyof typeof FEATURE_BADGES;

/** Returns the tag kind for a feature, or undefined when the feature is untagged. */
export function getFeatureBadge(id: FeatureBadgeId | undefined): FeatureBadgeKind | undefined {
  return id ? FEATURE_BADGES[id] : undefined;
}
