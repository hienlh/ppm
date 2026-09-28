/**
 * The metadata a `design` tab carries, and the one place that builds it.
 *
 * A design tab hosts an ordinary chat session plus the design's canvas, so its metadata is
 * a chat tab's (`sessionId`, `providerId`, `permissionMode`, ...) plus `designSlug`. Every
 * opener — the sidebar, the palette, the New Design dialog, a deep link — goes through
 * {@link designTabMetadata}, so none of them can forget the pending-provider flag.
 *
 * No `permissionMode` is written: the embedded chat then loads the provider's configured
 * default exactly as a new chat tab does, because a design agent reads and searches the
 * project constantly and a stricter mode would ask on every file.
 */

export interface DesignTabMetadataInput {
  projectName: string;
  designSlug: string;
  /** Known when the design is opened on a session that already exists. */
  sessionId?: string;
  /** Known when the caller picked the provider (the New Design dialog); pending otherwise. */
  providerId?: string;
  /** A design created just now has no sessions, so there is no latest one to look up. */
  fresh?: boolean;
}

export function designTabMetadata(input: DesignTabMetadataInput): Record<string, unknown> {
  const { projectName, designSlug, sessionId, providerId, fresh } = input;
  return {
    projectName,
    designSlug,
    ...(sessionId ? { sessionId } : {}),
    ...(providerId ? { providerId } : { providerPending: true }),
    ...(fresh ? { designSessionChecked: true } : {}),
  };
}

/** The design slug of a tab, or null when the tab is not a design tab. */
export function designSlugOf(tab: { type: string; metadata?: Record<string, unknown> } | undefined): string | null {
  if (!tab || tab.type !== "design") return null;
  const slug = tab.metadata?.designSlug;
  return typeof slug === "string" && slug ? slug : null;
}
