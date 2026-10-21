import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { shareBlockedReason } from "@/lib/design/design-share-address-state";
import { SHARE_LIMITS } from "../../../../shared/design-share-types";
import { DesignResponsiveDialog } from "../dialogs/design-responsive-dialog";
import { useDesignTab } from "../design-tab-context";
import { ShareAddressBlock } from "./share-address-block";
import { NewShareLinkFields, useNewShareLinkForm } from "./new-share-link-form";
import { SharedLinksList } from "./shared-links-list";
import { useShareAddress } from "./use-share-address";
import { useShareLinks } from "./use-share-links";

/**
 * Share for review: where links open, a new link (label, expiry, version), and the design's
 * existing links with their actions. A dialog on desktop, a bottom sheet on a phone, with
 * Create in the footer. While PPM sign-in is off nothing can be created and existing links
 * read as paused, because the server opens none of them.
 */

export interface DesignShareFeature {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export function useDesignShare(): DesignShareFeature {
  const [open, setOpen] = useState(false);
  return useMemo(() => ({ open, setOpen }), [open]);
}

export function DesignShareDialog({ feature }: { feature: DesignShareFeature }) {
  const { projectName, slug } = useDesignTab();
  const address = useShareAddress(feature.open);
  const links = useShareLinks(projectName, slug, feature.open);
  const form = useNewShareLinkForm(links);
  const blocked = shareBlockedReason(address.address, links.links?.length ?? 0, SHARE_LIMITS.maxLinksPerDesign);
  const signinOff = address.view.kind === "signin-off";

  const create = async () => {
    if (blocked) return;
    const link = await form.submit();
    if (!link) return;
    // No Copy action on the toast: a modal dialog blocks clicks outside itself, so the row's
    // own Copy button is the one that works. On a phone the list sits below the form.
    toast.success("Link created");
    requestAnimationFrame(() => {
      document.querySelector(`[data-link-id="${CSS.escape(link.id)}"]`)?.scrollIntoView({ block: "nearest" });
    });
  };

  return (
    <DesignResponsiveDialog
      open={feature.open}
      onClose={() => feature.setOpen(false)}
      title="Share for review"
      description="Reviewers open a saved version of this design and pin comments on it. They never see the live copy."
      className="sm:max-w-lg"
      footer={<>
        <Button variant="outline" onClick={() => feature.setOpen(false)}>Close</Button>
        <Button onClick={() => void create()} disabled={!!blocked || form.creating} data-testid="share-create"
          title={blocked ?? undefined}>
          {form.creating && <Loader2 className="size-4 animate-spin" />}
          {signinOff ? blocked : "Create link"}
        </Button>
      </>}
    >
      <div className="flex flex-col gap-4" data-testid="share-dialog">
        <ShareAddressBlock view={address.view} onStart={() => void address.startTemporary()} onRetryLoad={() => void address.refresh()} />
        {!signinOff && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">New link</h3>
            <NewShareLinkFields form={form} projectName={projectName} slug={slug} />
            {blocked && !form.error && address.address && <p className="text-xs text-text-subtle">{blocked}</p>}
          </section>
        )}
        <SharedLinksList links={links} address={address.address} />
      </div>
    </DesignResponsiveDialog>
  );
}
