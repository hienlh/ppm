/**
 * Shapes shared by the design REST surface and the browser.
 *
 * A design is the folder `designs/<slug>/` inside a project: an entry HTML file, a
 * `design.json` manifest, and a git-ignored `.design/` directory holding the canvas's own
 * working data (snapshots, comments). The slug never changes once a design exists, because
 * design sessions carry `designs/<slug>/` in their instructions.
 */

import type { DesignVariant } from "./design-variants";

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
  /**
   * The variants the canvas can switch between, variant 1 (the entry) first, only files that
   * exist. Absent from an older server, which means the entry alone (`designVariantsOf`).
   */
  variants?: DesignVariant[];
  /** Why entries of `design.json`'s `variants` were skipped; absent when none were. */
  variantWarnings?: string[];
  createdAt: string;
  /** Latest of the manifest's own timestamp and the entry file's mtime, ISO. */
  updatedAt: string;
  /** The app this design belongs to; `"default"` when the manifest names none. */
  system: string;
  /** Set when this design is an app's showcase (`designs/system-<id>/`); the app's id. */
  showcaseFor?: string;
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

/**
 * An "app" of the project: one declared design system under `designs/systems/<id>/`, or the
 * implicit `default` app backed by the legacy `designs/DESIGN.md` + `designs/tokens.css` +
 * `designs/kit/` (never moved). `root` is relative to the project root (`.` for the project
 * itself); `platform` decides whether the showcase and a design built for this app render in
 * a phone frame with native-looking components.
 */
export const DESIGN_PLATFORMS = ["web", "mobile"] as const;
export type DesignPlatform = (typeof DESIGN_PLATFORMS)[number];

export function isDesignPlatform(value: unknown): value is DesignPlatform {
  return typeof value === "string" && (DESIGN_PLATFORMS as readonly string[]).includes(value);
}

export interface DesignSystemBuiltFrom {
  /** `git rev-parse HEAD` of the app root at the moment a setup turn last finished. */
  commit: string;
  at: string;
}

export interface DesignSystemSummary {
  id: string;
  label: string;
  /** Relative to the project root; `.` for the project itself. */
  root: string;
  platform: DesignPlatform;
  /** True when `designs/systems/<id>/system.json` exists; false for the unreleased implicit default. */
  declared: boolean;
  builtFrom?: DesignSystemBuiltFrom;
  /** The New Design dialog's "Skip" was chosen for this app and must not ask again. */
  setupSkipped?: boolean;
  hasDesignMd: boolean;
  hasTokensCss: boolean;
}

/** Server-computed, cached per (root, HEAD); never blocks the designs list. */
export interface DesignSystemStaleInfo {
  stale: boolean;
  /** Files changed since `builtFrom.commit`, restricted to the app root. Present when known. */
  changedFiles?: number;
  /** True when there is no repo, no `builtFrom`, or the check timed out — "unknown", not stale. */
  unknown: boolean;
}

/** `YYYYMMDD-HHMMSS-xxxx` (UTC time + 4 hex). Checked after URL decoding, before any path use. */
export const SNAPSHOT_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export function isSnapshotId(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_ID_RE.test(value);
}

/** A design file's `gen`: 16 hex chars of the SHA-256 of its BOM-less text. */
export const DESIGN_GEN_RE = /^[0-9a-f]{16}$/;
