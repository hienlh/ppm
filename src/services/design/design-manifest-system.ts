import { DEFAULT_SYSTEM_ID, isValidSystemId } from "./design-systems-paths.ts";
import type { DesignManifest } from "./design-manifest.ts";

/**
 * The two manifest fields this phase adds, both carried through `design.json`'s untyped
 * `extra` bag (see {@link DesignManifest}) rather than becoming first-class fields, so an
 * older build that does not know them still round-trips the file unchanged.
 */

/** Which app a design belongs to: `manifest.system`, `default` when absent or invalid. */
export function manifestSystemId(manifest: DesignManifest): string {
  const value = manifest.extra.system;
  return isValidSystemId(value) ? value : DEFAULT_SYSTEM_ID;
}

/** The app id this design is the showcase for, or null for an ordinary design. */
export function manifestShowcaseFor(manifest: DesignManifest): string | null {
  const value = manifest.extra.showcaseFor;
  return isValidSystemId(value) ? value : null;
}

/** `design.json` fields to set on a new design for `system` (and, for a showcase, `showcaseFor`). */
export function systemManifestFields(systemId: string, showcaseFor?: string): Record<string, unknown> {
  return systemId === DEFAULT_SYSTEM_ID && !showcaseFor ? {} : { system: systemId, ...(showcaseFor ? { showcaseFor } : {}) };
}

/** Slug of the showcase design for an app: `system-<id>`, always a valid design slug. */
export function showcaseSlugFor(systemId: string): string {
  return `system-${systemId}`;
}
