import { describe, expect, it } from "bun:test";
import {
  SHARE_START_TIMEOUT_MS, SIGNIN_OFF_REASON, shareAddressView, shareBlockedReason, shareLinkUrl,
} from "../../../src/web/lib/design/design-share-address-state";
import type { DesignShareAddress } from "../../../src/shared/design-share-types";

const address = (extra: Partial<DesignShareAddress> = {}): DesignShareAddress => ({
  kind: "none", url: null, warning: null, via: "ppm", enabled: false, authEnabled: true, ...extra,
});
const named = address({ kind: "named", url: "https://ppm.example.com", enabled: true });
const quick = address({ kind: "quick", url: "https://quiet-river-1.trycloudflare.com", enabled: true });
const now = 1_000_000;
const view = (a: DesignShareAddress | null, extra: Partial<Parameters<typeof shareAddressView>[0]> = {}) =>
  shareAddressView({ address: a, loadError: null, start: null, now, ...extra });

describe("share address view", () => {
  it("is loading until the address arrives, and an error only when nothing is known", () => {
    expect(view(null)).toEqual({ kind: "loading" });
    expect(view(null, { loadError: "offline" })).toEqual({ kind: "error", message: "offline" });
    // A failed poll keeps the last address.
    expect(view(named, { loadError: "offline" }).kind).toBe("named");
  });

  it("shows the stable address without the temporary warning, and the quick one with it", () => {
    expect(view(named)).toEqual({ kind: "named", url: "https://ppm.example.com", warning: null, reviewOnly: false });
    expect(view(quick)).toEqual({ kind: "quick", url: "https://quiet-river-1.trycloudflare.com", warning: null, reviewOnly: false });
  });

  it("passes the supervisor's warning through, e.g. a named tunnel that is not connected", () => {
    const dark = address({ enabled: true, warning: "named tunnel is not connected" });
    expect(view(dark)).toEqual({ kind: "none", enabled: true, warning: "named tunnel is not connected" });
  });

  it("offers a start when there is no address and the switch is off", () => {
    expect(view(address())).toEqual({ kind: "none", enabled: false, warning: null });
  });

  it("is starting for a minute after Start, then failed", () => {
    const start = { at: now - 1000, target: "public" as const, reload: "sent" as const, error: null };
    expect(view(address({ enabled: true }), { start }).kind).toBe("starting");
    expect(view(address({ enabled: true }), { start: { ...start, reload: "busy" } }).kind).toBe("starting");
    const late = view(address({ enabled: true }), { start: { ...start, at: now - SHARE_START_TIMEOUT_MS - 1 } });
    expect(late.kind).toBe("failed");
    // The address arriving ends the start whatever the clock says.
    expect(view(quick, { start }).kind).toBe("quick");
  });

  it("fails at once when there is no supervisor to act on the switch, or the switch failed", () => {
    expect(view(address(), { start: { at: now, target: "public", reload: "no-supervisor", error: null } }).kind).toBe("failed");
    expect(view(address(), { start: { at: now, target: "public", reload: null, error: "HTTP 500" } }))
      .toEqual({ kind: "failed", message: "HTTP 500", target: "public" });
  });

  it("marks the review-only address, so the dialog can say PPM itself stays private", () => {
    const review = address({ kind: "named", url: "https://share.example.com", via: "share-host" });
    expect(view(review)).toEqual({ kind: "named", url: "https://share.example.com", warning: null, reviewOnly: true });
    expect(view({ ...review, kind: "quick" })).toMatchObject({ kind: "quick", reviewOnly: true });
  });

  it("is down rather than offering PPM's link when the review address is on but has no address", () => {
    const down = address({ via: "share-host", warning: "Not connected to Cloudflare right now — reconnecting." });
    expect(view(down)).toEqual({ kind: "review-down", warning: "Not connected to Cloudflare right now — reconnecting." });
  });

  it("starts the review-only address for a minute, then fails naming it", () => {
    const start = { at: now - 1000, target: "review" as const, reload: "sent" as const, error: null };
    expect(view(address(), { start })).toEqual({ kind: "starting", target: "review" });
    expect(view(address({ via: "share-host" }), { start })).toEqual({ kind: "starting", target: "review" });
    const late = view(address({ via: "share-host" }), { start: { ...start, at: now - SHARE_START_TIMEOUT_MS - 1 } });
    expect(late).toEqual({ kind: "failed", target: "review", message: "The review-only address did not come up within a minute." });
    // A change the supervisor could not take says why, at once.
    expect(view(address(), { start: { ...start, error: "Run `ppm restart` to apply." } }))
      .toEqual({ kind: "failed", target: "review", message: "Run `ppm restart` to apply." });
  });

  it("refuses sharing while PPM sign-in is off, whatever the tunnel is doing", () => {
    expect(view({ ...quick, authEnabled: false })).toEqual({ kind: "signin-off" });
    expect(shareBlockedReason({ ...quick, authEnabled: false }, 0, 20)).toBe(SIGNIN_OFF_REASON);
    expect(SIGNIN_OFF_REASON).toBe("Turn on PPM sign-in first");
  });
});

describe("share blocked reason", () => {
  it("allows a link with or without a public address, and refuses past the limit", () => {
    expect(shareBlockedReason(address(), 0, 20)).toBeNull();
    expect(shareBlockedReason(quick, 19, 20)).toBeNull();
    expect(shareBlockedReason(quick, 20, 20)).toContain("20 share links");
    expect(shareBlockedReason(null, 0, 20)).not.toBeNull();
  });
});

describe("share link URL", () => {
  it("is exactly the public address plus the link's path", () => {
    expect(shareLinkUrl(quick, "/s/abc123", "http://192.168.1.5:8080"))
      .toEqual({ url: "https://quiet-river-1.trycloudflare.com/s/abc123", isPublic: true });
    expect(shareLinkUrl({ ...named, url: "https://ppm.example.com/" }, "/s/abc123", "http://x"))
      .toEqual({ url: "https://ppm.example.com/s/abc123", isPublic: true });
  });

  it("falls back to this page's origin without a public address, and is null without a code", () => {
    expect(shareLinkUrl(address(), "/s/abc123", "http://192.168.1.5:8080"))
      .toEqual({ url: "http://192.168.1.5:8080/s/abc123", isPublic: false });
    expect(shareLinkUrl(null, "/s/abc123", "http://localhost:3000")?.isPublic).toBe(false);
    expect(shareLinkUrl(quick, null, "http://x")).toBeNull();
  });
});
