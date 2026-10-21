import { SHARE_LIMITS, type DesignShareErrorCode, type DesignShareLinkStatus } from "../../../shared/design-share-types.ts";
import { configService } from "../../config.service.ts";
import { DesignError, isDesignError } from "../design-error.ts";
import { resolveDesignDir } from "../design-paths.ts";
import type { ShareLinkRecord } from "./design-share-links-store.ts";

/** Input checks, the status rule, and the facts both the owner list and the guest lookup need. */

/** PPM sign-in. With it off, nothing is shared and no code opens a link. */
export function shareAuthEnabled(): boolean {
  return configService.get("auth").enabled;
}

/** The design folder, or null when the design no longer exists. */
export async function designDirOrNull(projectPath: string, slug: string): Promise<string | null> {
  try {
    return await resolveDesignDir(projectPath, slug);
  } catch (e) {
    if (isDesignError(e) && e.status === 404) return null;
    throw e;
  }
}

export function shareError(status: number, code: DesignShareErrorCode, message: string): DesignError {
  return new DesignError(status, code, message);
}

// Control characters, line breaks and the bidi overrides that could make a label read as
// something else. Other format characters stay, or a joined emoji could not be used.
const CONTROL_CHARS = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u;

/** A label of at most {@link SHARE_LIMITS.maxLabelChars} printable characters, trimmed. */
export function parseShareLabel(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw shareError(400, "bad-input", "The label must be text");
  const label = value.trim();
  if (CONTROL_CHARS.test(label)) throw shareError(400, "bad-input", "The label may not contain control characters");
  if ([...label].length > SHARE_LIMITS.maxLabelChars) {
    throw shareError(400, "bad-input", `The label may be at most ${SHARE_LIMITS.maxLabelChars} characters`);
  }
  return label;
}

/** Null (never expires) or an epoch-ms time after now and at most a year ahead, by server time. */
export function parseShareExpiry(value: unknown, now: number): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw shareError(400, "bad-input", "expiresAt must be null or a time in milliseconds");
  }
  if (value <= now) throw shareError(400, "bad-input", "The expiry must be in the future");
  if (value > now + SHARE_LIMITS.maxExpiryMs) throw shareError(400, "bad-input", "The expiry may be at most a year ahead");
  return value;
}

/** `true` or absent; anything else is a malformed request rather than "no". */
export function parseFlag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (value !== true) throw shareError(400, "bad-input", `${name} must be true when given`);
  return true;
}

export interface ShareStatusFacts {
  now: number;
  authEnabled: boolean;
  /** The stored hash is the hash of the code derived from today's secret. */
  codeCurrent: boolean;
  /** The design and its pinned snapshot both exist. */
  snapshotPresent: boolean;
}

/**
 * A link's status, the most final reason first. `signin-off` comes last because it is the
 * only one that turning sign-in back on fixes: a link reported as `signin-off` is otherwise
 * active.
 */
export function shareLinkStatus(link: ShareLinkRecord, facts: ShareStatusFacts): DesignShareLinkStatus {
  if (link.revokedAt !== null) return "revoked";
  if (!facts.codeCurrent) return "needs-new-code";
  if (!facts.snapshotPresent) return "design-missing";
  if (link.expiresAt !== null && link.expiresAt <= facts.now) return "expired";
  if (!facts.authEnabled) return "signin-off";
  return "active";
}
