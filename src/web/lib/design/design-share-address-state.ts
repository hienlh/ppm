import type { DesignShareAddress } from "../../../shared/design-share-types";

/**
 * What the Share dialog's address block shows, decided from the address route, the tunnel
 * start the owner asked for, and the clock. Pure, so every state is tested without a server.
 */

/** Poll interval while a temporary address is starting. */
export const SHARE_START_POLL_MS = 2_000;
/** How long a start may take before the dialog says it did not come up. */
export const SHARE_START_TIMEOUT_MS = 60_000;

export const SIGNIN_OFF_REASON = "Turn on PPM sign-in first";
export const QUICK_ADDRESS_WARNING =
  "This is a temporary address. It changes when PPM or the tunnel restarts, and links you already sent stop working; copy them again then.";

/** What the tunnel switch answered (`POST /api/tunnel/enabled`). */
export type TunnelReload = "sent" | "busy" | "no-supervisor";

export interface ShareStartAttempt {
  /** Epoch ms the owner pressed Start. */
  at: number;
  /** Null until the switch answered. */
  reload: TunnelReload | null;
  /** The switch itself failed. */
  error: string | null;
}

export type ShareAddressView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "signin-off" }
  | { kind: "named"; url: string; warning: string | null }
  | { kind: "quick"; url: string; warning: string | null }
  | { kind: "starting" }
  | { kind: "failed"; message: string }
  /** No public address; `enabled` = the switch is on but nothing is serving (a dark tunnel). */
  | { kind: "none"; enabled: boolean; warning: string | null };

export interface ShareAddressInputs {
  address: DesignShareAddress | null;
  loadError: string | null;
  start: ShareStartAttempt | null;
  now: number;
}

export function shareAddressView({ address, loadError, start, now }: ShareAddressInputs): ShareAddressView {
  if (!address) return loadError ? { kind: "error", message: loadError } : { kind: "loading" };
  if (!address.authEnabled) return { kind: "signin-off" };
  if (address.url && address.kind !== "none") {
    return address.kind === "named"
      ? { kind: "named", url: address.url, warning: address.warning }
      : { kind: "quick", url: address.url, warning: address.warning };
  }
  if (start) {
    if (start.error) return { kind: "failed", message: start.error };
    if (start.reload === "no-supervisor") {
      return {
        kind: "failed",
        message: "PPM is running without its supervisor, so nothing can start the tunnel now. It starts the next time PPM is started normally.",
      };
    }
    if (now - start.at <= SHARE_START_TIMEOUT_MS) return { kind: "starting" };
    return { kind: "failed", message: address.warning ?? "The temporary address did not come up within a minute." };
  }
  return { kind: "none", enabled: address.enabled, warning: address.warning };
}

/** Why a new link cannot be created right now, or null when it can. */
export function shareBlockedReason(address: DesignShareAddress | null, linkCount: number, maxLinks: number): string | null {
  if (!address) return "Reading the sharing state…";
  if (!address.authEnabled) return SIGNIN_OFF_REASON;
  if (linkCount >= maxLinks) return `This design already has ${maxLinks} share links; delete one first`;
  return null;
}

/**
 * The URL a link is copied as: the public address plus its path, or this page's own origin
 * when there is no public address (it then opens only where this PPM is reachable).
 */
export function shareLinkUrl(
  address: DesignShareAddress | null, path: string | null, localOrigin: string,
): { url: string; isPublic: boolean } | null {
  if (!path) return null;
  const publicUrl = address && address.kind !== "none" ? address.url : null;
  if (publicUrl) return { url: publicUrl.replace(/\/+$/, "") + path, isPublic: true };
  return { url: localOrigin.replace(/\/+$/, "") + path, isPublic: false };
}
