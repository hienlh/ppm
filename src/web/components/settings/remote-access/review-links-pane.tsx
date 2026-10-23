/**
 * Settings → Remote Access → Review links: a public address for design review links that opens
 * the review pages and nothing else of PPM — no editor, chats, files or sign-in page answer
 * there — so a design can be shared while PPM itself stays private.
 *
 * A process of its own (the share host) answers that address and passes only the review pages
 * through to PPM. It reaches Cloudflare one of three ways: a temporary trycloudflare address, a
 * tunnel of its own on the user's domain, or a second hostname on PPM's named tunnel. As on the
 * Public link pane, the switch only writes config and the supervisor applies it, so the state is
 * polled (`use-share-host-status.ts`). Setting a domain up is `review-address-setup.tsx`, which
 * the Share dialog uses too.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Lock, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { shareHostApi } from "@/lib/api-share-host";
import { openSettings } from "../open-settings";
import { Notice } from "../tailscale/tailscale-settings-section";
import { AdaptiveDialog } from "../tailscale/tailscale-ui";
import { AddressOption } from "./public-link-pane";
import { reportApplied, ReviewAddressSetupView, useReviewAddressSetup } from "./review-address-setup";
import { useShareHostStatus } from "./use-share-host-status";

const btn = "min-h-11 cursor-pointer md:min-h-9";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ReviewLinksPane() {
  const { status, setStatus, loadError, refresh, connecting } = useShareHostStatus();
  const setup = useReviewAddressSetup(status, refresh);
  const [pending, setPending] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [confirmTemporary, setConfirmTemporary] = useState(false);

  const setEnabled = async (next: boolean) => {
    setPending(true);
    setStatus((s) => s && { ...s, enabled: next });
    try {
      const applied = await shareHostApi.setEnabled(next);
      if (!applied.applied) reportApplied(applied, next ? "Review address turned on" : "Review address turned off");
      await refresh();
    } catch (e) {
      setStatus((s) => s && { ...s, enabled: !next });
      toast.error(next ? "Could not turn the review address on" : "Could not turn the review address off", { description: message(e) });
    } finally {
      setPending(false);
    }
  };

  const switchToTemporary = async () => {
    setConfirmTemporary(false);
    setSwitching(true);
    try {
      reportApplied(await shareHostApi.useTemporary(), "Switched to a temporary address");
      await refresh();
    } catch (e) {
      toast.error("Could not switch to a temporary address", { description: message(e) });
    } finally {
      setSwitching(false);
    }
  };

  if (!status) {
    return (
      <p className="text-sm text-muted-foreground">
        {loadError ? `Could not read the review address's state: ${loadError}` : "Reading the review address's state…"}
      </p>
    );
  }

  const { enabled, mode, authEnabled } = status;
  const hostname = mode === "quick" ? null : status.hostname;
  const ppmHostname = status.ppmTunnel.named ? status.ppmTunnel.hostname : null;

  return (
    <div className="space-y-6" data-testid="review-links-pane">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Share design review links without making PPM public. Reviewers get an address of its own that
        opens the review pages and nothing else: no editor, chats, files or sign-in page answer there.
      </p>

      <section className="space-y-4 rounded-lg border border-border p-4" data-testid="review-links-switch-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="review-links-switch" className="text-sm font-medium">Review address</Label>
            <p className="text-sm leading-relaxed text-muted-foreground" data-testid="review-links-status">
              {!enabled
                ? "Off."
                : status.connected
                  ? <>On. Review links open at <span className="break-all font-medium text-foreground">{status.url}</span></>
                  : status.running
                    ? "On. Connecting to Cloudflare…"
                    : "On. Starting…"}
            </p>
          </div>
          <div className="flex min-h-11 shrink-0 items-center gap-2">
            {(pending || (connecting && status.canApply)) && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <Switch
              id="review-links-switch"
              checked={enabled}
              disabled={pending || (!enabled && !authEnabled)}
              onCheckedChange={(on) => void setEnabled(on)}
            />
          </div>
        </div>

        {!authEnabled && (
          <Notice icon={<Lock className="size-4" />}>
            <p>PPM's password is off, and share links do not open while it is. Turn it on first.</p>
            <Button variant="outline" onClick={() => openSettings("general")} className={btn}>Open General</Button>
          </Notice>
        )}
        {enabled && !status.canApply && (
          <Notice icon={<TriangleAlert className="size-4 text-warning" />}>
            <p>
              {status.supervised
                ? "This PPM was started before review addresses existed. Run `ppm restart` to apply these settings."
                : "Review addresses run under `ppm start`. This PPM was started without it, so nothing serves the address."}
            </p>
          </Notice>
        )}
      </section>

      <section className="space-y-3" data-testid="review-links-address">
        <h3 className="text-sm font-medium">Address</h3>
        {setup.flow ? (
          <div className="rounded-lg border border-border p-4" data-testid="review-links-setup">
            <ReviewAddressSetupView setup={setup} ppmHostname={ppmHostname} />
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            <AddressOption
              title="Temporary address"
              inUse={mode === "quick"}
              description="A random trycloudflare.com address of its own. It changes every time PPM restarts, and links already sent stop working then."
              action={mode !== "quick" && (
                <Button variant="outline" onClick={() => setConfirmTemporary(true)} disabled={switching} className={btn}>
                  {switching ? <Loader2 className="size-4 animate-spin" /> : "Switch"}
                </Button>
              )}
            />
            <AddressOption
              title="Your domain, its own tunnel"
              inUse={mode === "named"}
              description={mode === "named" && hostname
                ? <><span className="break-all font-medium text-foreground">https://{hostname}</span>, on a Cloudflare tunnel of its own.</>
                : "A fixed address like share.example.com, on a Cloudflare tunnel of its own. PPM's public link is not involved."}
              action={authEnabled && (
                <Button variant={mode === "named" ? "outline" : "default"} onClick={() => setup.begin("named")} className={btn}
                  data-testid="review-links-setup-named">
                  {mode === "named" ? "Change" : "Set up"}
                </Button>
              )}
            />
            <AddressOption
              title="Your domain, on PPM's tunnel"
              inUse={mode === "shared"}
              description={mode === "shared" && hostname
                ? <><span className="break-all font-medium text-foreground">https://{hostname}</span>, on the tunnel of PPM's public link. PPM's own address answers only while that link is on.</>
                : "A fixed address like share.example.com, added to the tunnel PPM's public link uses. PPM's own address answers only while that link is on."}
              action={authEnabled && status.ppmTunnel.named && (
                <Button variant={mode === "shared" ? "outline" : "default"} onClick={() => setup.begin("shared")} className={btn}
                  data-testid="review-links-setup-shared">
                  {mode === "shared" ? "Change" : "Set up"}
                </Button>
              )}
            />
          </div>
        )}

        {!setup.flow && !authEnabled && (
          <p className="text-xs text-muted-foreground">Turn on PPM's password to use your own domain.</p>
        )}
        {!setup.flow && authEnabled && !status.ppmTunnel.named && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            To use PPM's tunnel, set your domain up under Public link first. Its link can stay off.
          </p>
        )}
        {enabled && status.warning && (
          <Notice icon={<TriangleAlert className="size-4 text-warning" />}>
            <p>{status.warning}</p>
          </Notice>
        )}
      </section>

      <AdaptiveDialog open={confirmTemporary} title="Switch to a temporary address?" onClose={() => setConfirmTemporary(false)}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Review links stop opening at https://{hostname} and get a new random address instead. Links
            already sent with your domain stop working until you set it up again.
          </p>
          <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
            <Button variant="outline" onClick={() => setConfirmTemporary(false)} className={btn}>Cancel</Button>
            <Button variant="destructive" onClick={() => void switchToTemporary()} className={btn}>Switch</Button>
          </div>
        </div>
      </AdaptiveDialog>
    </div>
  );
}
