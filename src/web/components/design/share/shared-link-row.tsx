import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, KeyRound, MoreHorizontal } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { shareLinkUrl } from "@/lib/design/design-share-address-state";
import {
  DESTRUCTIVE_SHARE_ACTIONS, SHARE_ACTION_LABEL, shareLinkActions, shareLinkTitle, shareStatusChip,
  type ShareChipTone, type ShareLinkActionId,
} from "@/lib/design/design-share-link-status";
import type { DesignShareAddress, DesignShareLink } from "../../../../shared/design-share-types";
import { SharedLinkActionPanel, type ShareRowPanel } from "./shared-link-action-panels";
import type { ShareLinksFeature } from "./use-share-links";

/**
 * One share link: its name, status, full address, Copy and Open as reviewer inline, and the
 * rest behind More (a visible button, so a phone needs no hidden gesture) or a right-click /
 * long-press menu. A chosen action opens its step inline under the row.
 */

const TONE: Record<ShareChipTone, string> = {
  ok: "bg-success/15 text-success",
  warn: "bg-warning/15 text-warning",
  muted: "bg-surface-elevated text-text-subtle",
  danger: "bg-destructive/15 text-destructive",
};

const versionLine = (link: DesignShareLink) => link.snapshotCreatedAt
  ? `Version from ${new Date(link.snapshotCreatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
  : "The pinned version is no longer on disk";

const expiryLine = (link: DesignShareLink) => link.expiresAt === null
  ? "Never expires"
  : `Open until ${new Date(link.expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;

export function SharedLinkRow({ link, address, links }: {
  link: DesignShareLink;
  address: DesignShareAddress | null;
  links: ShareLinksFeature;
}) {
  const [panel, setPanel] = useState<ShareRowPanel | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const chip = shareStatusChip(link, Date.now());
  const target = shareLinkUrl(address, link.path, window.location.origin);
  const reviewerHref = link.path ? window.location.origin + link.path : null;
  const actions = shareLinkActions(link, address?.authEnabled ?? true);
  const choose = (id: ShareLinkActionId) => { setMenuOpen(false); setPanel(id); };

  const copy = async () => {
    if (!target) return;
    if (await copyToClipboard(target.url)) {
      toast.success("Link copied", {
        description: target.isPublic ? undefined : "There is no public address, so this link opens only where this PPM is reachable from.",
      });
    } else {
      toast.error("Could not copy the link", { description: target.url });
    }
  };

  const menuItems = actions.map((id, i) => (
    <Fragment key={id}>
      {DESTRUCTIVE_SHARE_ACTIONS.has(id) && !DESTRUCTIVE_SHARE_ACTIONS.has(actions[i - 1] ?? "expiry") && <ContextMenuSeparator />}
      <ContextMenuItem variant={DESTRUCTIVE_SHARE_ACTIONS.has(id) ? "destructive" : "default"} onClick={() => choose(id)}>
        {SHARE_ACTION_LABEL[id]}
      </ContextMenuItem>
    </Fragment>
  ));

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="share-link-row" data-link-id={link.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex select-none flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={shareLinkTitle(link)}>{shareLinkTitle(link)}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", TONE[chip.tone])} data-testid="share-link-status">
                {chip.label}
              </span>
            </div>
            {target
              ? <p className="break-all font-mono text-xs text-text-2" data-testid="share-link-url">{target.url}</p>
              : <p className="text-xs text-text-subtle">
                  {link.status === "needs-new-code" ? "The code for this link is gone. Issue a new code to share it again." : "This link no longer opens."}
                </p>}
            <p className="text-xs text-text-subtle">{versionLine(link)} · {expiryLine(link)}</p>
            <div className="flex flex-wrap gap-2 [&>*]:min-h-11 md:[&>*]:min-h-8">
              {link.status === "needs-new-code" && actions.includes("new-code") ? (
                <Button size="sm" onClick={() => setPanel("new-code")}><KeyRound className="size-4" /> New code</Button>
              ) : (
                <Button size="sm" variant="outline" disabled={!target} onClick={() => void copy()}>
                  <Copy className="size-4" /> Copy link
                </Button>
              )}
              {reviewerHref ? (
                <Button size="sm" variant="outline" asChild>
                  <a href={reviewerHref} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" /> Open as reviewer</a>
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled><ExternalLink className="size-4" /> Open as reviewer</Button>
              )}
              <Button size="sm" variant="ghost" aria-expanded={menuOpen} aria-label={`More actions for ${shareLinkTitle(link)}`}
                onClick={() => { setPanel(null); setMenuOpen((v) => !v); }} className="ml-auto">
                <MoreHorizontal className="size-4" /> More
              </Button>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>{menuItems}</ContextMenuContent>
      </ContextMenu>
      {menuOpen && (
        <div role="group" aria-label="Link actions" className="grid grid-cols-1 gap-1 border-t border-border pt-2 sm:grid-cols-2">
          {actions.map((id) => (
            <button key={id} type="button" onClick={() => choose(id)}
              className={cn("flex min-h-11 items-center rounded-md px-3 text-left text-sm hover:bg-surface-elevated md:min-h-8",
                DESTRUCTIVE_SHARE_ACTIONS.has(id) && "text-destructive")}>
              {SHARE_ACTION_LABEL[id]}
            </button>
          ))}
        </div>
      )}
      {panel && (
        <SharedLinkActionPanel key={typeof panel === "string" ? panel : "repinned"} panel={panel} link={link} links={links}
          onClose={() => setPanel(null)} onShow={setPanel} />
      )}
    </li>
  );
}
