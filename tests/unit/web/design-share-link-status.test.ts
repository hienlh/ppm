import { describe, expect, it } from "bun:test";
import { shareLinkActions, shareLinkTitle, shareStatusChip } from "../../../src/web/lib/design/design-share-link-status";
import type { DesignShareLink } from "../../../src/shared/design-share-types";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date(2026, 9, 21, 12).getTime();
const link = (extra: Partial<DesignShareLink> = {}): DesignShareLink => ({
  id: "l1", label: "Client", snapshotId: "s1", snapshotCreatedAt: "2026-10-21T05:00:00.000Z",
  createdAt: now - DAY, updatedAt: now - DAY, expiresAt: null, revokedAt: null, status: "active", path: "/s/abc", ...extra,
});

describe("share link status chip", () => {
  it("names every status, paused included", () => {
    expect(shareStatusChip(link(), now)).toEqual({ label: "Active", tone: "ok" });
    expect(shareStatusChip(link({ expiresAt: now + 3 * DAY }), now).label).toBe("Expires in 3 days");
    expect(shareStatusChip(link({ status: "expired" }), now).label).toBe("Expired");
    expect(shareStatusChip(link({ status: "revoked" }), now).label).toBe("Revoked");
    expect(shareStatusChip(link({ status: "needs-new-code", path: null }), now).label).toBe("Needs new code");
    expect(shareStatusChip(link({ status: "design-missing" }), now).label).toBe("Design missing");
    expect(shareStatusChip(link({ status: "signin-off" }), now)).toEqual({ label: "Paused: sign-in is off", tone: "warn" });
  });

  it("names an unlabelled link after the day it was made", () => {
    expect(shareLinkTitle(link())).toBe("Client");
    expect(shareLinkTitle(link({ label: "" }))).toStartWith("Link from ");
  });
});

describe("share link actions", () => {
  it("offers everything for a live link", () => {
    expect(shareLinkActions(link(), true)).toEqual(["expiry", "rename", "repin", "new-code", "delete-comments", "revoke", "delete"]);
  });

  it("offers nothing that would reopen a revoked link", () => {
    expect(shareLinkActions(link({ status: "revoked" }), true)).toEqual(["rename", "delete-comments", "delete"]);
  });

  it("leaves out re-pin and new code while sign-in is off, as the server refuses them", () => {
    expect(shareLinkActions(link({ status: "signin-off" }), false)).toEqual(["expiry", "rename", "delete-comments", "revoke", "delete"]);
  });
});
