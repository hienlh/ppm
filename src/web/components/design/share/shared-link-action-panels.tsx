import { useState } from "react";
import { toast } from "sonner";
import { choiceForExpiry, expiryFromChoice } from "@/lib/design/design-share-expiry";
import type { ShareLinkActionId } from "@/lib/design/design-share-link-status";
import { SHARE_LIMITS, type DesignShareChangedFiles, type DesignShareLink } from "../../../../shared/design-share-types";
import { ShareExpiryPicker } from "./share-expiry-picker";
import { ShareChangedFiles } from "./share-changed-files";
import { Check, Panel } from "./share-row-panel";
import { ShareRepinPanel } from "./share-repin-panel";
import type { ShareLinksFeature } from "./use-share-links";

/**
 * The inline step a row action opens under its link: an edit (expiry, label) or a
 * confirmation. Inline rather than a second modal, so a phone's sheet never stacks another
 * sheet, and each step's buttons sit at the bottom of what it shows.
 */

export type ShareRowPanel = ShareLinkActionId | { repinned: DesignShareChangedFiles | null };

export function SharedLinkActionPanel({ panel, link, links, onClose, onShow }: {
  panel: ShareRowPanel;
  link: DesignShareLink;
  links: ShareLinksFeature;
  onClose: () => void;
  /** Swaps to another step (the re-pin result). */
  onShow: (next: ShareRowPanel) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expiry, setExpiry] = useState(() => choiceForExpiry(link.expiresAt, Date.now()));
  const [expiryError, setExpiryError] = useState<string | null>(null);
  const [label, setLabel] = useState(link.label);
  const [alsoComments, setAlsoComments] = useState(false);

  const run = async (work: () => Promise<boolean>) => {
    setBusy(true);
    try { if (await work()) onClose(); } finally { setBusy(false); }
  };
  const purgeComments = async () => {
    if (!alsoComments) return true;
    const ok = await links.deleteComments(link.id);
    if (ok) toast.success("The link's comments were deleted");
    return ok;
  };

  if (typeof panel === "object") {
    return (
      <Panel onCancel={onClose} cancelLabel="Done">
        <p className="font-medium">Reviewers now see the latest version. Files that differ from the one they had:</p>
        <ShareChangedFiles files={panel.repinned} />
      </Panel>
    );
  }

  switch (panel) {
    case "expiry": {
      const save = () => {
        const next = expiryFromChoice(expiry, Date.now());
        if (!next.ok) { setExpiryError(next.error); return; }
        void run(async () => !!(await links.update(link.id, { expiresAt: next.expiresAt }, "Could not change the expiry")));
      };
      return (
        <Panel confirm="Save expiry" busy={busy} onCancel={onClose} onConfirm={save}>
          <ShareExpiryPicker idPrefix={`share-${link.id}`} value={expiry} error={expiryError}
            onChange={(c) => { setExpiry(c); setExpiryError(null); }} />
        </Panel>
      );
    }
    case "rename":
      return (
        <Panel confirm="Save label" busy={busy} onCancel={onClose}
          onConfirm={() => void run(async () => !!(await links.update(link.id, { label: label.trim() }, "Could not rename the link")))}>
          <input autoFocus value={label} maxLength={SHARE_LIMITS.maxLabelChars} aria-label="Label"
            onChange={(e) => setLabel(e.target.value)}
            className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary md:min-h-9" />
        </Panel>
      );
    case "repin":
      return <ShareRepinPanel link={link} links={links} onClose={onClose} onRepinned={(files) => onShow({ repinned: files })} />;
    case "new-code":
      return (
        <Panel confirm="Issue new code" busy={busy} onCancel={onClose}
          onConfirm={() => void run(async () => !!(await links.update(link.id, { newCode: true }, "Could not issue a new code")))}>
          <p>The link's current address stops working. Send the new one to your reviewers.</p>
        </Panel>
      );
    case "delete-comments":
      return (
        <Panel confirm="Delete comments" destructive busy={busy} onCancel={onClose} onConfirm={() => void run(async () => {
          const ok = await links.deleteComments(link.id);
          if (ok) toast.success("The link's comments were deleted");
          return ok;
        })}>
          <p>Deletes every comment thread reviewers started on this link, with their replies. This cannot be undone.</p>
        </Panel>
      );
    case "revoke":
      return (
        <Panel confirm="Revoke link" destructive busy={busy} onCancel={onClose} onConfirm={() => void run(async () => {
          if (!(await links.update(link.id, { revoke: true }, "Could not revoke the link"))) return false;
          // The revoke stands either way; a failed purge has already said so in a toast.
          await purgeComments();
          return true;
        })}>
          <p>Revoking is final: the link stops opening and cannot be turned back on.</p>
          <Check checked={alsoComments} onChange={setAlsoComments} label="Also delete this link's comments" />
        </Panel>
      );
    case "delete":
      return (
        <Panel confirm="Delete link" destructive busy={busy} onCancel={onClose} onConfirm={() => void run(async () => {
          // Comments first: once the row is gone it is no longer in this list to delete them from.
          if (!(await purgeComments())) return false;
          return links.remove(link.id);
        })}>
          <p>The link stops opening and leaves this list. Its comment threads stay on the canvas unless you delete them too.</p>
          <Check checked={alsoComments} onChange={setAlsoComments} label="Also delete this link's comments" />
        </Panel>
      );
  }
}
