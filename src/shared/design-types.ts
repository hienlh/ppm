/**
 * Shapes shared by the design REST surface and the browser.
 *
 * A design is the folder `designs/<slug>/` inside a project: an entry HTML file, a
 * `design.json` manifest, and a git-ignored `.design/` directory holding the canvas's own
 * working data (snapshots, comments). The slug never changes once a design exists, because
 * design sessions carry `designs/<slug>/` in their instructions.
 */

/** `slides` is a deck of 1280x720 sections; `page` is a single page or prototype. */
export const DESIGN_KINDS = ["page", "slides"] as const;
export type DesignKind = (typeof DESIGN_KINDS)[number];

export function isDesignKind(value: unknown): value is DesignKind {
  return typeof value === "string" && (DESIGN_KINDS as readonly string[]).includes(value);
}

export interface DesignSummary {
  slug: string;
  title: string;
  kind: DesignKind;
  /** Entry HTML file, relative to the design folder. */
  entry: string;
  createdAt: string;
  /** Latest of the manifest's own timestamp and the entry file's mtime, ISO. */
  updatedAt: string;
}

/**
 * Why a snapshot exists. `before-edit` snapshots (taken ahead of a canvas write-back) have
 * their own, smaller retention pool so a burst of them can never push real history out.
 */
export const DESIGN_SNAPSHOT_REASONS = ["turn", "pre-restore", "before-edit", "manual"] as const;
export type DesignSnapshotReason = (typeof DESIGN_SNAPSHOT_REASONS)[number];

export interface DesignSnapshotInfo {
  id: string;
  reason: DesignSnapshotReason;
  createdAt: string;
  /** The chat session whose turn produced this snapshot, for `turn` snapshots. */
  sessionId?: string;
  /** For `pre-restore`: the snapshot that was being restored when this one was taken. */
  restoreOf?: string;
  fileCount: number;
  bytes: number;
  treeHash: string;
}

/** Whether the project-level design system files exist (`designs/DESIGN.md`, `designs/tokens.css`). */
export interface DesignSystemStatus {
  designMd: boolean;
  tokensCss: boolean;
}

/** `YYYYMMDD-HHMMSS-xxxx` (UTC time + 4 hex). Checked after URL decoding, before any path use. */
export const SNAPSHOT_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export function isSnapshotId(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_ID_RE.test(value);
}

/** A design file's `gen`: 16 hex chars of the SHA-256 of its BOM-less text. */
export const DESIGN_GEN_RE = /^[0-9a-f]{16}$/;
