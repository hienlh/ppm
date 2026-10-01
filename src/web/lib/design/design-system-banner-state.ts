import type { DesignSystemStaleInfo, DesignSystemSummary } from "../../../shared/design-types";

/**
 * Whether a design tab shows the "refresh the design system" banner.
 *
 * Kept pure (no React, no storage) so the decision is testable. Setting a system up is no
 * longer offered here: a design's own first turn does that itself (`design-instructions.ts`),
 * so the only thing left for this banner to ever offer is re-running it once it is stale.
 */

export type DesignSystemBannerKind = "refresh";

export interface DesignSystemBannerInput {
  system: DesignSystemSummary | null;
  stale: DesignSystemStaleInfo | null;
  /** Kinds the user dismissed for this app on this device. */
  dismissed: readonly DesignSystemBannerKind[];
  /** A turn is running in this tab: a refresh in progress must not be offered again. */
  isStreaming: boolean;
}

export function designSystemBannerKind(input: DesignSystemBannerInput): DesignSystemBannerKind | null {
  const { system, stale, dismissed, isStreaming } = input;
  if (!system || isStreaming) return null;
  const kind: DesignSystemBannerKind | null = stale && !stale.unknown && stale.stale ? "refresh" : null;
  return kind && !dismissed.includes(kind) ? kind : null;
}

/** localStorage key of the dismissals for one app of one project. */
export function designSystemBannerKey(projectName: string, systemId: string): string {
  return `ppm.design.systemBanner.${projectName}/${systemId}`;
}

export function parseDismissed(raw: string | null): DesignSystemBannerKind[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((k): k is DesignSystemBannerKind => k === "refresh") : [];
  } catch {
    return [];
  }
}
