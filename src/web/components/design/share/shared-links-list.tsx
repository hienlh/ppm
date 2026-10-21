import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { SHARE_LIMITS, type DesignShareAddress } from "../../../../shared/design-share-types";
import { SharedLinkRow } from "./shared-link-row";
import type { ShareLinksFeature } from "./use-share-links";

/** The design's share links, newest first, each with its own actions. */
export function SharedLinksList({ links, address }: { links: ShareLinksFeature; address: DesignShareAddress | null }) {
  if (!links.links) {
    return links.error ? (
      <div className="flex flex-col gap-2 text-sm" role="alert">
        <p className="text-destructive">{links.error}</p>
        <div><Button variant="outline" className="min-h-11 md:min-h-9" onClick={() => void links.refresh()}>Try again</Button></div>
      </div>
    ) : (
      <p className="flex items-center gap-2 text-sm text-text-subtle"><Loader2 className="size-4 animate-spin" /> Loading links…</p>
    );
  }
  return (
    <section className="flex flex-col gap-2" data-testid="share-links">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
        Shared links ({links.links.length} of {SHARE_LIMITS.maxLinksPerDesign})
      </h3>
      {links.links.length === 0
        ? <p className="text-sm text-text-subtle">No links yet. A link opens one saved version of this design for reviewers to comment on.</p>
        : (
          <ul className="flex flex-col gap-2">
            {links.links.map((link) => <SharedLinkRow key={link.id} link={link} address={address} links={links} />)}
          </ul>
        )}
    </section>
  );
}
