/**
 * The metadata a `design` tab carries, and the one place that builds it.
 *
 * A design tab hosts an ordinary chat session plus the design's canvas, so its metadata is
 * a chat tab's (`sessionId`, `providerId`, `permissionMode`, ...) plus `designSlug`. Every
 * opener — the sidebar, the palette, the New Design dialog, a deep link — goes through
 * {@link designTabMetadata}, so none of them can forget the permission default or the
 * pending-provider flag.
 */

/**
 * The permission mode a design chat starts in: file edits inside the project are approved,
 * everything else asks. Mirrors the server's own default for design sessions; it is written
 * into the tab because the composer sends its mode explicitly, and an explicit mode wins over
 * the session's stored one — without it the composer would load the global default (usually
 * `bypassPermissions`) and silently run the design chat in bypass.
 */
export const DESIGN_PERMISSION_MODE = "acceptEdits";

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
    permissionMode: DESIGN_PERMISSION_MODE,
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
