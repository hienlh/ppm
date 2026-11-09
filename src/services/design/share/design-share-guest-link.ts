import type { DesignKind } from "../../../shared/design-types.ts";
import type { DesignVariant } from "../../../shared/design-variants.ts";
import { projectNameForPath } from "../../project-name-for-path.ts";
import { readDesignFileSafe } from "../design-safe-walk.ts";
import { parseManifest, MANIFEST_FILE } from "../design-manifest.ts";
import { manifestSystemId } from "../design-manifest-system.ts";
import { resolveDesignVariants } from "../design-variants-resolve.ts";
import { snapshotFilesDir } from "../design-snapshot-history.ts";
import { resolveSnapshotScopedPath } from "../preview/design-preview-scope.ts";
import { GUEST_VERSION_CHANGED } from "../../../shared/design-share-guest-types.ts";
import { DesignError } from "../design-error.ts";
import { resolveShareCode, type ResolvedShareLink } from "./design-share-resolve.ts";
import { getShareLink } from "./design-share-links-store.ts";
import { shareAuthEnabled } from "./design-share-link-rules.ts";
import { INVALID_LINK_MESSAGE } from "./design-share-guest-page.ts";

/**
 * What a reviewer's code opens, as the guest routes see it: the share link resolved (see
 * `resolveShareCode`), refused as well while its project is no longer registered in PPM,
 * and the pinned snapshot's own manifest — title, kind, pages and app — read from the
 * snapshot, never from the live design.
 */

export interface GuestSnapshotManifest {
  title: string;
  kind: DesignKind;
  entry: string;
  variants: DesignVariant[];
  /** The app whose design-system files the snapshot links (`default` when none). */
  system: string;
}

const MAX_MANIFEST_BYTES = 256 * 1024;
/** Snapshots never change, so a manifest read once is good for as long as it is cached. */
const MAX_CACHED_MANIFESTS = 128;
const manifests = new Map<string, GuestSnapshotManifest>();

/** The link `code` opens for a reviewer, or null for every reason it does not. */
export async function resolveGuestLink(code: string): Promise<ResolvedShareLink | null> {
  let resolved: ResolvedShareLink | null;
  try {
    resolved = await resolveShareCode(code);
  } catch {
    // A refused design folder (a symlink, outside the project) opens nothing either.
    return null;
  }
  if (!resolved || projectNameForPath(resolved.link.projectPath) === null) return null;
  return resolved;
}

/** Code of the refusal {@link assertGuestLinkOpen} throws; the routes answer it as a dead code. */
export const GUEST_LINK_CLOSED = "ELINKCLOSED";

/**
 * Throws when the link `resolved` was read from no longer opens the way it did: deleted,
 * revoked, expired, given a new code, sign-in turned off, or its project removed. With a
 * `versionId`, also when the link now shows another snapshot than that one (a re-pin), so a
 * comment is never pinned to a version its page was not showing. Synchronous, so it can run
 * inside the design lock right before a reviewer's write, and again before the owner is told.
 */
export function assertGuestLinkOpen(resolved: ResolvedShareLink, versionId?: string): void {
  const { link } = resolved;
  const row = getShareLink(link.id);
  const open = row !== null && row.revokedAt === null && (row.expiresAt === null || row.expiresAt > Date.now())
    && row.codeVersion === link.codeVersion && row.codeHash === link.codeHash
    && shareAuthEnabled() && projectNameForPath(row.projectPath) !== null;
  if (!open) throw new DesignError(404, GUEST_LINK_CLOSED, INVALID_LINK_MESSAGE);
  if (versionId !== undefined && row.snapshotId !== versionId) throw guestVersionChanged();
}

export function guestVersionChanged(): DesignError {
  return new DesignError(409, GUEST_VERSION_CHANGED, "This design was updated. Reload the page to comment on the new version.");
}

/** True when {@link assertGuestLinkOpen} would let a write through. */
export function guestLinkOpen(resolved: ResolvedShareLink): boolean {
  try {
    assertGuestLinkOpen(resolved);
    return true;
  } catch {
    return false;
  }
}

async function readSnapshotManifestRaw(resolved: ResolvedShareLink): Promise<string | null> {
  const { link } = resolved;
  try {
    const asset = await resolveSnapshotScopedPath(link, link.snapshotId, `${link.slug}/${MANIFEST_FILE}`);
    return (await readDesignFileSafe(asset.abs, MAX_MANIFEST_BYTES)).toString("utf8");
  } catch {
    // Missing, refused or oversized: the snapshot reads as a design with default fields.
    return null;
  }
}

export async function guestSnapshotManifest(resolved: ResolvedShareLink): Promise<GuestSnapshotManifest> {
  const { link, designDir, snapshot } = resolved;
  const key = `${designDir}\0${snapshot.id}`;
  const hit = manifests.get(key);
  if (hit) return hit;
  const { manifest } = parseManifest(await readSnapshotManifestRaw(resolved), { slug: link.slug, now: snapshot.createdAt });
  const { variants } = await resolveDesignVariants(snapshotFilesDir(designDir, snapshot.id), manifest);
  const value: GuestSnapshotManifest = {
    title: manifest.title, kind: manifest.kind, entry: manifest.entry, variants, system: manifestSystemId(manifest),
  };
  manifests.set(key, value);
  if (manifests.size > MAX_CACHED_MANIFESTS) manifests.delete(manifests.keys().next().value!);
  return value;
}
