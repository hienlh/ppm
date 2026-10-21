import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { isSnapshotId, type DesignSnapshotInfo } from "../../../shared/design-types.ts";
import {
  SHARE_LIMITS, SHARE_PATH_PREFIX, type DesignShareChangedFiles, type DesignShareLink, type UpdateDesignShareResult,
} from "../../../shared/design-share-types.ts";
import { projectKey } from "../../project-name-for-path.ts";
import { isValidDesignSlug } from "../design-slug.ts";
import { withRecoveredDesign } from "../design-restore-journal.ts";
import { readSnapshotInfo } from "../design-snapshot-history.ts";
import { snapshotDesign } from "../design-snapshots.service.ts";
import { deriveCode, hashCode } from "./design-share-code.ts";
import {
  applyShareLinkChange, deleteShareLinkRow, getShareLink, insertShareLink, listShareLinksForDesign,
  type ShareLinkRecord,
} from "./design-share-links-store.ts";
import {
  designDirOrNull, parseFlag, parseShareExpiry, parseShareLabel, shareAuthEnabled, shareError, shareLinkStatus,
} from "./design-share-link-rules.ts";
import { diffSnapshotFiles, diffSnapshotWithLive } from "./design-share-changed-files.ts";

/**
 * The owner's share links and the one lookup a guest request goes through.
 *
 * While PPM sign-in is off nothing can be shared: a public address would then expose all of
 * PPM, not one design. New links, re-pins and new codes are refused, and no code resolves.
 * The rows are kept, so the links open again once sign-in is back on.
 */

function requireSignIn(): void {
  if (!shareAuthEnabled()) throw shareError(409, "signin-off", "Turn on PPM sign-in before sharing");
}

function newRecord(projectPath: string, slug: string, snapshotId: string, label: string, expiresAt: number | null): ShareLinkRecord {
  const id = randomBytes(6).toString("hex");
  const now = Date.now();
  return {
    id, codeHash: hashCode(deriveCode(id, 1)), codeVersion: 1,
    projectPath: resolve(projectPath), projectKey: projectKey(projectPath), slug, snapshotId,
    label, createdAt: now, updatedAt: now, expiresAt, revokedAt: null,
  };
}

/** The owner's view of a row. The code is re-derived; only a hash was ever stored. */
function toLink(record: ShareLinkRecord, snapshot: DesignSnapshotInfo | null): DesignShareLink {
  const code = deriveCode(record.id, record.codeVersion);
  const codeCurrent = hashCode(code) === record.codeHash;
  const status = shareLinkStatus(record, {
    now: Date.now(), authEnabled: shareAuthEnabled(), codeCurrent, snapshotPresent: snapshot !== null,
  });
  const issuable = codeCurrent && status !== "revoked";
  return {
    id: record.id, label: record.label, snapshotId: record.snapshotId,
    snapshotCreatedAt: snapshot?.createdAt ?? null,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    expiresAt: record.expiresAt, revokedAt: record.revokedAt,
    status, path: issuable ? `${SHARE_PATH_PREFIX}${code}` : null,
  };
}

async function linkView(record: ShareLinkRecord): Promise<DesignShareLink> {
  const dir = await designDirOrNull(record.projectPath, record.slug);
  return toLink(record, dir ? await readSnapshotInfo(dir, record.snapshotId) : null);
}

/** The pin a manual snapshot taken now gives: a new snapshot, or the newest when nothing changed. */
async function snapshotNow(projectPath: string, slug: string): Promise<string> {
  const taken = await snapshotDesign(projectPath, slug, "manual");
  if ("id" in taken) return taken.id;
  if (taken.skipped === "unchanged") return taken.sameAs;
  if (taken.skipped === "missing") throw shareError(404, "not-found", `Design not found: ${slug}`);
  throw shareError(409, "too-large", "The design is too large to snapshot, so it cannot be shared");
}

const limitReached = () => shareError(
  409, "limit", `This design already has ${SHARE_LIMITS.maxLinksPerDesign} share links; delete one first`,
);

function insertOrRefuse(record: ShareLinkRecord): void {
  if (!insertShareLink(record)) throw limitReached();
}

export async function createShareLink(projectPath: string, slug: string, input: Record<string, unknown>): Promise<DesignShareLink> {
  requireSignIn();
  const label = parseShareLabel(input.label);
  if (!("expiresAt" in input)) throw shareError(400, "bad-input", "expiresAt is required (null for never)");
  const expiresAt = parseShareExpiry(input.expiresAt, Date.now());
  const version = input.version;
  // Checked again by the insert; this only spares a snapshot that could not be used.
  if (listShareLinksForDesign(projectKey(projectPath), slug).length >= SHARE_LIMITS.maxLinksPerDesign) throw limitReached();
  if (version === "current") {
    const record = newRecord(projectPath, slug, await snapshotNow(projectPath, slug), label, expiresAt);
    insertOrRefuse(record);
    return linkView(record);
  }
  if (!isSnapshotId(version)) throw shareError(400, "bad-input", 'version must be "current" or a snapshot id');
  // Under the design lock, so the snapshot cannot be pruned between the check and the insert.
  return withRecoveredDesign(projectPath, slug, async (dir) => {
    const info = await readSnapshotInfo(dir, version);
    if (!info) throw shareError(404, "not-found", `Snapshot not found: ${version}`);
    const record = newRecord(projectPath, slug, version, label, expiresAt);
    insertOrRefuse(record);
    return toLink(record, info);
  });
}

export async function listShareLinks(projectPath: string, slug: string): Promise<DesignShareLink[]> {
  if (!isValidDesignSlug(slug)) throw shareError(400, "bad-input", "Invalid design slug");
  const records = listShareLinksForDesign(projectKey(projectPath), slug);
  const dir = records.length ? await designDirOrNull(projectPath, slug) : null;
  return Promise.all(records.map(async (r) => toLink(r, dir ? await readSnapshotInfo(dir, r.snapshotId) : null)));
}

/** A link of this design, or a 404 (a link of another design is not this route's to touch). */
function ownLink(projectPath: string, slug: string, id: string): ShareLinkRecord {
  const record = getShareLink(id);
  if (!record || record.projectKey !== projectKey(projectPath) || record.slug !== slug) {
    throw shareError(404, "not-found", "Share link not found");
  }
  return record;
}

export async function updateShareLink(
  projectPath: string, slug: string, id: string, input: Record<string, unknown>,
): Promise<UpdateDesignShareResult> {
  const record = ownLink(projectPath, slug, id);
  const now = Date.now();
  const revoke = parseFlag(input.revoke, "revoke");
  const repin = parseFlag(input.repin, "repin");
  const newCode = parseFlag(input.newCode, "newCode");
  const label = "label" in input ? parseShareLabel(input.label) : undefined;
  const expiresAt = "expiresAt" in input ? parseShareExpiry(input.expiresAt, now) : undefined;
  if (!revoke && !repin && !newCode && label === undefined && expiresAt === undefined) {
    throw shareError(400, "bad-input", "Nothing to change");
  }
  if ((repin || newCode) && (revoke || record.revokedAt !== null)) {
    throw shareError(409, "revoked", "A revoked link cannot be re-pinned or given a new code");
  }
  if (repin || newCode) requireSignIn();

  // Only what this request names is written, against the row as it is after the snapshot:
  // a revoke or new code from another tab committed while it ran is kept, never undone.
  const snapshotId = repin ? await snapshotNow(projectPath, slug) : undefined;
  const applied = applyShareLinkChange(id, {
    updatedAt: Date.now(), label, expiresAt, revoke, snapshotId,
    newCodeHash: newCode ? (version) => hashCode(deriveCode(id, version)) : undefined,
  });
  if (applied === "missing") throw shareError(404, "not-found", "Share link not found");
  if (applied === "revoked") throw shareError(409, "revoked", "This link was revoked, so it cannot be re-pinned or given a new code");
  const link = await linkView(applied.record);
  if (!repin) return { link };
  const dir = await designDirOrNull(projectPath, slug);
  const changedFiles = dir ? await diffSnapshotFiles(dir, applied.previous.snapshotId, applied.record.snapshotId) : null;
  return { link, changedFiles };
}

/**
 * What "Update to latest" would change for reviewers of this link: its pinned snapshot
 * against the live design files, read the way the re-pin's snapshot would be. Null when the
 * pinned snapshot is gone. Read under the design lock, so neither a prune nor a restore can
 * move files while they are compared.
 */
export async function previewShareRepin(projectPath: string, slug: string, id: string): Promise<DesignShareChangedFiles | null> {
  const record = ownLink(projectPath, slug, id);
  if (record.revokedAt !== null) throw shareError(409, "revoked", "A revoked link cannot be re-pinned");
  return withRecoveredDesign(projectPath, slug, (dir) => diffSnapshotWithLive(dir, record.snapshotId));
}

export function deleteShareLink(projectPath: string, slug: string, id: string): void {
  ownLink(projectPath, slug, id);
  if (!deleteShareLinkRow(id)) throw shareError(404, "not-found", "Share link not found");
}

export { resolveShareCode, type ResolvedShareLink } from "./design-share-resolve.ts";
