/**
 * Design share links: what the owner's REST routes answer with, and the limits both the
 * server and the Share dialog enforce.
 *
 * A link opens one pinned snapshot of one design at `/s/<code>`. Only the path is ever
 * sent; the base URL is the public address of the moment (see {@link DesignShareAddress}),
 * so a changed tunnel hostname does not break a link.
 */

export const SHARE_LIMITS = {
  /** Links per design, revoked ones included until they are deleted. */
  maxLinksPerDesign: 20,
  /** Characters (code points) in a link's label. */
  maxLabelChars: 60,
  /** Furthest expiry the owner may set, from now. */
  maxExpiryMs: 366 * 24 * 60 * 60 * 1000,
  /** File names listed after a re-pin. */
  maxChangedFiles: 200,
} as const;

/** URL prefix of every share link. */
export const SHARE_PATH_PREFIX = "/s/";

/**
 * - `active`: opens for anyone holding the code.
 * - `expired`: past `expiresAt`; the owner can extend it.
 * - `revoked`: final.
 * - `needs-new-code`: the secret the code was derived from is gone; "New code" fixes it.
 * - `design-missing`: the design or its pinned snapshot no longer exists.
 * - `signin-off`: would be active, but no link opens while PPM sign-in is off.
 */
export type DesignShareLinkStatus =
  | "active" | "expired" | "revoked" | "needs-new-code" | "design-missing" | "signin-off";

export interface DesignShareLink {
  id: string;
  label: string;
  snapshotId: string;
  /** When the pinned snapshot was taken (ISO), or null when it is gone. */
  snapshotCreatedAt: string | null;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  /** Epoch ms, or null for a link that never expires. */
  expiresAt: number | null;
  revokedAt: number | null;
  status: DesignShareLinkStatus;
  /** `/s/<code>`, or null when no code can be given out (revoked, or `needs-new-code`). */
  path: string | null;
}

/** Files that differ between the old and the new pin, relative to the design folder. */
export interface DesignShareChangedFiles {
  added: string[];
  removed: string[];
  changed: string[];
  /** More files differed than {@link SHARE_LIMITS.maxChangedFiles} names. */
  truncated: boolean;
}

export interface CreateDesignShareInput {
  label?: string;
  expiresAt: number | null;
  /** `"current"` pins a snapshot taken now; otherwise an existing snapshot id. */
  version: string;
}

export interface UpdateDesignShareInput {
  label?: string;
  expiresAt?: number | null;
  revoke?: true;
  /** Take a snapshot now and pin it. */
  repin?: true;
  /** Issue a new code; the old one stops opening the link. */
  newCode?: true;
}

export interface UpdateDesignShareResult {
  link: DesignShareLink;
  /** Present after a re-pin; null when the old snapshot was gone and could not be compared. */
  changedFiles?: DesignShareChangedFiles | null;
}

/** Error codes the share routes answer with beside the message (`{ ok, error, code }`). */
export type DesignShareErrorCode =
  | "signin-off" | "limit" | "revoked" | "too-large" | "bad-input" | "not-found";

/** The public address a share link is reachable at right now. */
export interface DesignShareAddress {
  /** `named`: the stable hostname; `quick`: a temporary one that changes on restart. */
  kind: "named" | "quick" | "none";
  /** Origin without a trailing slash, or null for `none`. */
  url: string | null;
  /** The supervisor's tunnel warning, passed through (for example, a dark named tunnel). */
  warning: string | null;
  /**
   * `share-host`: the review address, which reaches the review pages and nothing else of PPM
   * (Settings → Remote Access → Review links); `ppm`: PPM's own public link.
   */
  via: "share-host" | "ppm";
  /** The public tunnel master switch. */
  enabled: boolean;
  /** PPM sign-in; sharing is refused while it is off. */
  authEnabled: boolean;
}
