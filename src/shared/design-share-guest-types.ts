import type { DesignKind } from "./design-types.ts";
import type { DesignVariant } from "./design-variants.ts";
import type { DesignCommentGuestView } from "./design-comment-thread-types.ts";

/**
 * The reviewer's side of a share link: what `/s/<code>/…` answers and what it expects.
 *
 * - `GET /s/<code>/info` → {@link DesignShareGuestInfo}
 * - `GET /s/<code>/f/<slug>/<file>?n=<nonce>` → the pinned snapshot's files (the design frame)
 * - `GET /s/<code>/comments` → {@link DesignShareGuestThreads}, with an `ETag`; send it back
 *   as `If-None-Match` and an unchanged list answers 304
 * - writes (`POST`/`PATCH`/`DELETE` under `/s/<code>/comments`) carry `Content-Type:
 *   application/json`, `X-PPM-Request: 1` and {@link GUEST_KEY_HEADER}
 *
 * Every response is `{ ok, data }` or `{ ok: false, error, code? }`. A code that does not open
 * answers 404 with the same body whatever the reason; 429 carries `Retry-After` in seconds.
 */

/** The reviewer's browser key: 32 random bytes, unpadded base64url. */
export const GUEST_KEY_HEADER = "X-PPM-Guest-Key";
export const GUEST_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

/** Largest body a reviewer's write may send. */
export const GUEST_WRITE_MAX_BYTES = 16 * 1024;

export interface DesignShareGuestInfo {
  /** Opaque id of the link, for the page's own storage keys. Not a credential. */
  linkId: string;
  /** The design's folder name, the first segment of every frame path: `/s/<code>/f/<slug>/…`. */
  slug: string;
  title: string;
  kind: DesignKind;
  entry: string;
  variants: DesignVariant[];
  /** Epoch ms, or null for a link that never expires. */
  expiresAt: number | null;
  /** When the shared version was taken (ISO). */
  versionCreatedAt: string;
  /**
   * Opaque id of the shared version. A new comment names it (`versionId` in its body), and
   * the thread list carries the one shown now: when they differ the owner has re-pinned the
   * link, and the page has to reload before it can comment again.
   */
  versionId: string;
}

export interface DesignShareGuestThreads {
  threads: DesignCommentGuestView[];
  /** The version the link shows now (see {@link DesignShareGuestInfo.versionId}). */
  versionId: string;
}

/** Error code of a new comment made on a version the link no longer shows. */
export const GUEST_VERSION_CHANGED = "version-changed";

/** Answer of every write that leaves a thread (new root, reply, edit, reply deleted). */
export interface DesignShareGuestThread {
  thread: DesignCommentGuestView;
}
