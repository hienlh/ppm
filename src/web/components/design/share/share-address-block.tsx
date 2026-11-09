import type { ReactNode } from "react";
import { Globe, Loader2, Lock, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { openSettings } from "@/components/settings/open-settings";
import { openRemoteAccess } from "@/components/settings/remote-access/remote-access-tab-store";
import {
  QUICK_ADDRESS_WARNING, SIGNIN_OFF_REASON, type ShareAddressView, type ShareStartTarget,
} from "@/lib/design/design-share-address-state";

/**
 * Where share links open: the stable address, the temporary one with its warning, or no
 * public address with the ways to make PPM itself public. The review-only address, which
 * reaches the review pages and nothing else of PPM, is switched and set up in the card below
 * this block (`review-address-card.tsx`); this block only says where links open. With PPM
 * sign-in off it says only that sharing waits for sign-in, because a link would otherwise open
 * all of PPM.
 */

const btn = "min-h-11 cursor-pointer md:min-h-9";

function Box({ tone = "plain", icon, children, testId }: {
  tone?: "plain" | "warn"; icon: ReactNode; children: ReactNode; testId: string;
}) {
  return (
    <div data-testid={testId}
      className={cn("flex gap-3 rounded-lg border p-3 text-sm leading-relaxed",
        tone === "warn" ? "border-warning/40 bg-warning/10" : "border-border bg-surface-elevated/40")}>
      <span className="mt-0.5 shrink-0 text-text-subtle">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </div>
  );
}

/** PPM's own public link on a domain; the review-only address has its own in the card below. */
const SetUpPermanent = () => (
  <Button variant="outline" className={btn} onClick={() => openRemoteAccess("public-link")}>
    Set up a permanent address
  </Button>
);

const REVIEW_ONLY_NOTE = "Only the review pages answer at this address. The rest of PPM stays private.";
const PPM_ITSELF_NOTE = "This address opens PPM itself, behind its sign-in.";

export function ShareAddressBlock({ view, onStart, onRetryLoad }: {
  view: ShareAddressView;
  onStart: (target: ShareStartTarget) => void;
  onRetryLoad: () => void;
}) {
  switch (view.kind) {
    case "loading":
      return <Box testId="share-address-loading" icon={<Loader2 className="size-4 animate-spin" />}>Reading the public address…</Box>;
    case "error":
      return (
        <Box testId="share-address-error" tone="warn" icon={<TriangleAlert className="size-4" />}>
          <p>Could not read the public address: {view.message}</p>
          <div><Button variant="outline" className={btn} onClick={onRetryLoad}>Try again</Button></div>
        </Box>
      );
    case "signin-off":
      return (
        <Box testId="share-address-signin-off" tone="warn" icon={<Lock className="size-4" />}>
          <p className="font-medium">{SIGNIN_OFF_REASON}</p>
          <p className="text-text-2">
            A share link reaches PPM itself, so with sign-in off anyone holding one could open all of PPM.
            Existing links are paused until sign-in is back on.
          </p>
          <div><Button variant="outline" className={btn} onClick={() => openSettings("general")}>Open General</Button></div>
        </Box>
      );
    case "named":
    case "quick":
      return (
        <Box testId={`share-address-${view.kind}`} tone={view.kind === "quick" || view.warning ? "warn" : "plain"}
          icon={view.kind === "quick" ? <TriangleAlert className="size-4" /> : <Globe className="size-4" />}>
          <p>Links open at <span className="break-all font-medium text-foreground">{view.url}</span></p>
          {view.warning && <p className="text-text-2">{view.warning}</p>}
          {view.reviewOnly
            ? <p className="text-text-2" data-testid="share-address-review-only">{REVIEW_ONLY_NOTE}</p>
            : <p className="text-text-2" data-testid="share-address-ppm-itself">{PPM_ITSELF_NOTE}</p>}
          {view.kind === "quick" && <p className="text-text-2">{QUICK_ADDRESS_WARNING}</p>}
          {view.kind === "quick" && !view.reviewOnly && <div><SetUpPermanent /></div>}
        </Box>
      );
    case "starting":
      return (
        <Box testId="share-address-starting" icon={<Loader2 className="size-4 animate-spin" />}>
          {view.target === "review" ? "Starting a review-only address…" : "Starting a temporary public address…"} This
          usually takes a few seconds.
        </Box>
      );
    case "review-down":
      return (
        <Box testId="share-address-review-down" tone="warn" icon={<TriangleAlert className="size-4" />}>
          <p>The review-only address is switched on but not connected right now.</p>
          {view.warning && <p className="text-text-2">{view.warning}</p>}
          <p className="text-text-2">Until it is, links open only where this PPM is reachable from.</p>
        </Box>
      );
    case "failed":
    case "none": {
      const failed = view.kind === "failed";
      const darkTunnel = view.kind === "none" && view.enabled;
      return (
        <Box testId={failed ? "share-address-failed" : "share-address-none"} tone={failed || darkTunnel ? "warn" : "plain"}
          icon={<TriangleAlert className="size-4" />}>
          {failed ? <p>{view.message}</p> : <>
            <p>{darkTunnel ? "The public address is switched on but not connected right now." : "There is no public address yet."}</p>
            {view.warning && <p className="text-text-2">{view.warning}</p>}
            <p className="text-text-2">Until there is one, links open only where this PPM is reachable from.</p>
            {!darkTunnel && (
              <p className="text-text-2">
                A review-only address opens the review pages and nothing else of PPM. A public address
                opens PPM itself, behind its sign-in.
              </p>
            )}
          </>}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {failed ? (
              <Button className={btn} onClick={() => onStart(view.target)}>Try again</Button>
            ) : darkTunnel ? (
              <Button className={btn} onClick={() => onStart("public")}>Reconnect the public address</Button>
            ) : (
              <Button variant="outline" className={btn} onClick={() => onStart("public")}>Start a temporary public address</Button>
            )}
            {!(failed && view.target === "review") && <SetUpPermanent />}
          </div>
        </Box>
      );
    }
  }
}
