import type { DesignShareLink } from "../../../shared/design-share-types";
import { expiresInLabel } from "./design-share-expiry";

/**
 * How one share link reads in the owner's list: its status chip, and which actions still
 * make sense for it. Pure; the server decides the status, this only words it.
 */

export type ShareChipTone = "ok" | "warn" | "muted" | "danger";

export interface ShareStatusChip {
  label: string;
  tone: ShareChipTone;
}

export function shareStatusChip(link: DesignShareLink, now: number): ShareStatusChip {
  switch (link.status) {
    case "revoked": return { label: "Revoked", tone: "muted" };
    case "expired": return { label: "Expired", tone: "muted" };
    case "needs-new-code": return { label: "Needs new code", tone: "warn" };
    case "design-missing": return { label: "Design missing", tone: "danger" };
    case "signin-off": return { label: "Paused: sign-in is off", tone: "warn" };
    case "active": {
      const left = expiresInLabel(link.expiresAt, now);
      return { label: left && left !== "Expired" ? left : "Active", tone: "ok" };
    }
  }
}

/** The name a link is listed under; an unlabelled one is named after when it was made. */
export function shareLinkTitle(link: DesignShareLink): string {
  if (link.label) return link.label;
  const made = new Date(link.createdAt);
  return `Link from ${made.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export type ShareLinkActionId =
  | "expiry" | "rename" | "repin" | "new-code" | "delete-comments" | "revoke" | "delete";

/**
 * Actions offered for a link, in menu order. A revoked link is final, so nothing that would
 * reopen it is offered; re-pin and new code need sign-in, as the server refuses them without.
 */
export function shareLinkActions(link: DesignShareLink, authEnabled: boolean): ShareLinkActionId[] {
  const revoked = link.status === "revoked";
  const actions: ShareLinkActionId[] = [];
  if (!revoked) actions.push("expiry");
  actions.push("rename");
  if (!revoked && authEnabled) actions.push("repin", "new-code");
  actions.push("delete-comments");
  if (!revoked) actions.push("revoke");
  actions.push("delete");
  return actions;
}

export const SHARE_ACTION_LABEL: Record<ShareLinkActionId, string> = {
  expiry: "Change expiry",
  rename: "Rename",
  repin: "Update to latest version",
  "new-code": "New code",
  "delete-comments": "Delete this link's comments",
  revoke: "Revoke",
  delete: "Delete",
};

export const DESTRUCTIVE_SHARE_ACTIONS: ReadonlySet<ShareLinkActionId> = new Set(["delete-comments", "revoke", "delete"]);
