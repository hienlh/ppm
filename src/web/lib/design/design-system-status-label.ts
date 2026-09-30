import type { DesignSystemStaleInfo, DesignSystemSummary } from "../../../shared/design-types";

/** "not set up" / "ready" / "may be outdated (N UI files changed)", shared by the sidebar's
 * "Design systems" group and Settings → Design's "Apps in this project" list. */
export function designSystemStatusLabel(system: DesignSystemSummary, stale: DesignSystemStaleInfo | null): string {
  if (!system.hasDesignMd) return "Not set up";
  if (stale && !stale.unknown && stale.stale) return `May be outdated (${stale.changedFiles ?? "?"} UI files changed)`;
  if (system.builtFrom) return `Built ${new Date(system.builtFrom.at).toLocaleDateString()}`;
  return "Ready";
}
