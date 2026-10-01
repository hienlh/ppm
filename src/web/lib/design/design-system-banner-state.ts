import type { DesignSystemStaleInfo, DesignSystemSummary } from "../../../shared/design-types";

/**
 * Whether a design tab shows the "set up / refresh the design system" banner, and which.
 *
 * Kept pure (no React, no storage) so the decision is testable: the banner is the one
 * prominent way into setup, so "when does it show" is the part worth pinning down.
 */

export type DesignSystemBannerKind = "setup" | "refresh";

export interface DesignSystemBannerInput {
  system: DesignSystemSummary | null;
  stale: DesignSystemStaleInfo | null;
  /** Kinds the user dismissed for this app on this device. */
  dismissed: readonly DesignSystemBannerKind[];
  /** A turn is running in this tab: a setup in progress must not be offered again. */
  isStreaming: boolean;
}

export function designSystemBannerKind(input: DesignSystemBannerInput): DesignSystemBannerKind | null {
  const { system, stale, dismissed, isStreaming } = input;
  if (!system || isStreaming) return null;
  const kind: DesignSystemBannerKind | null = !system.hasDesignMd
    ? "setup"
    : stale && !stale.unknown && stale.stale ? "refresh" : null;
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
    return Array.isArray(value) ? value.filter((k): k is DesignSystemBannerKind => k === "setup" || k === "refresh") : [];
  } catch {
    return [];
  }
}
