import type { DesignSnapshotInfo } from "../../../shared/design-types.ts";
import { readSnapshotInfo } from "../design-snapshot-history.ts";
import { codeMatches, hashCode, SHARE_CODE_RE } from "./design-share-code.ts";
import { getShareLinkByCodeHash, type ShareLinkRecord } from "./design-share-links-store.ts";
import { designDirOrNull, shareAuthEnabled } from "./design-share-link-rules.ts";

export interface ResolvedShareLink {
  link: ShareLinkRecord;
  /** Real path of the design folder. */
  designDir: string;
  /** The pinned snapshot, which exists. */
  snapshot: DesignSnapshotInfo;
}

/**
 * The link a guest's code opens, or null for every reason it does not: sign-in off, an
 * unknown or retired code, revoked, expired (by server time), or a design or snapshot that
 * is gone. The reasons are not told apart, so a guest learns nothing from a refusal.
 */
export async function resolveShareCode(code: string): Promise<ResolvedShareLink | null> {
  if (!SHARE_CODE_RE.test(code) || !shareAuthEnabled()) return null;
  const link = getShareLinkByCodeHash(hashCode(code));
  // The hash matching is not enough: after the secret is replaced, an old code still hashes
  // to its row, and that link is `needs-new-code` until the owner issues one.
  if (!link || !codeMatches(code, link.id, link.codeVersion)) return null;
  if (link.revokedAt !== null || (link.expiresAt !== null && link.expiresAt <= Date.now())) return null;
  const designDir = await designDirOrNull(link.projectPath, link.slug);
  const snapshot = designDir ? await readSnapshotInfo(designDir, link.snapshotId) : null;
  if (!designDir || !snapshot) return null;
  return { link, designDir, snapshot };
}
