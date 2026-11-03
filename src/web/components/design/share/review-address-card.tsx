import { useState } from "react";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { shareHostApi, type ShareHostMode } from "@/lib/api-share-host";
import {
  reportApplied, ReviewAddressSetupView, useReviewAddressSetup, type DomainMode,
} from "@/components/settings/remote-access/review-address-setup";
import type { ShareHostStatusFeature } from "@/components/settings/remote-access/use-share-host-status";

/**
 * The review-only address, switched on and given a domain from the Share dialog itself: the same
 * switch and domain setup as Settings → Remote Access → Review links, here because that is where
 * people look when they share — including when PPM's own public link already gives links an
 * address, which then opens PPM itself. The address block above says where links open now.
 */

const btn = "min-h-11 cursor-pointer md:min-h-9";

const IN_USE: Record<ShareHostMode, string> = {
  quick: "On a temporary address.",
  named: "On your domain, with a tunnel of its own.",
  shared: "On your domain, on PPM's tunnel.",
};

function Choice({ title, description, onClick, testId }: {
  title: string; description: string; onClick: () => void; testId: string;
}) {
  return (
    <button type="button" onClick={onClick} data-testid={testId}
      className="flex min-h-11 w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border border-border p-3 text-left transition-colors hover:bg-surface-elevated">
      <span className="font-medium text-foreground">{title}</span>
      <span className="text-text-2">{description}</span>
    </button>
  );
}

export function ReviewAddressCard({ shareHost, onTurnOn, onChanged }: {
  shareHost: ShareHostStatusFeature;
  /** Switch the address on and follow it coming up (the address block shows that). */
  onTurnOn: () => Promise<void>;
  /** Where links open may have changed: read it again. */
  onChanged: () => void;
}) {
  const { status, setStatus, refresh } = shareHost;
  const setup = useReviewAddressSetup(status, refresh, onChanged);
  const [pending, setPending] = useState(false);
  const [choosing, setChoosing] = useState(false);
  // With sign-in off the dialog says sharing is paused; there is nothing to switch here.
  if (!status || !status.authEnabled) return null;

  const { enabled, mode } = status;
  const ppmHostname = status.ppmTunnel.named ? status.ppmTunnel.hostname : null;
  const savedDomain = mode !== "quick" ? status.hostname : null;

  const setEnabled = async (next: boolean) => {
    setPending(true);
    setChoosing(false);
    if (!next) (setup.flow?.k === "login" ? setup.cancelLogin : setup.cancel)();
    setStatus((s) => s && { ...s, enabled: next });
    try {
      if (next) {
        await onTurnOn();
      } else {
        const applied = await shareHostApi.setEnabled(false);
        if (!applied.applied) reportApplied(applied, "Review-only address turned off");
      }
    } catch (e) {
      toast.error(`Could not turn the review-only address ${next ? "on" : "off"}`, { description: e instanceof Error ? e.message : String(e) });
    } finally {
      await refresh();
      onChanged();
      setPending(false);
    }
  };

  // PPM's tunnel is an option only once PPM's own public link is on a domain.
  const useDomain = () => (ppmHostname ? setChoosing(true) : setup.begin("named"));
  const choose = (next: DomainMode) => { setChoosing(false); setup.begin(next); };

  return (
    <section data-testid="share-review-card" className="flex flex-col gap-3 rounded-lg border border-border p-3 text-sm leading-relaxed">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-text-subtle" />
          <div className="min-w-0 space-y-1">
            <Label htmlFor="share-review-switch" className="text-sm font-medium">Review-only address</Label>
            <p className="text-text-2" data-testid="share-review-state">
              {enabled
                ? IN_USE[mode]
                : "Reviewers get an address of their own that opens the review pages and nothing else of PPM."}
            </p>
            {!enabled && savedDomain && (
              <p className="text-text-2">Turning it on uses <span className="break-all font-medium text-foreground">https://{savedDomain}</span>.</p>
            )}
          </div>
        </div>
        <div className="flex min-h-11 shrink-0 items-center gap-2 md:min-h-9">
          {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          <Switch id="share-review-switch" checked={enabled} disabled={pending} onCheckedChange={(on) => void setEnabled(on)} />
        </div>
      </div>

      {enabled && !setup.flow && !choosing && (
        <div>
          <Button variant="outline" className={btn} onClick={useDomain} data-testid="share-review-domain">
            {mode === "quick" ? "Use my domain" : "Change domain"}
          </Button>
        </div>
      )}

      {choosing && ppmHostname && (
        <div className="flex flex-col gap-2 border-t border-border pt-3" data-testid="share-review-choose">
          <p className="font-medium">Which tunnel should carry it?</p>
          <Choice testId="share-review-choose-shared" onClick={() => choose("shared")}
            title="PPM's tunnel"
            description={`Added to the tunnel https://${ppmHostname} uses. Review links keep working when PPM's public link is off.`} />
          <Choice testId="share-review-choose-named" onClick={() => choose("named")}
            title="A tunnel of its own"
            description="PPM creates a Cloudflare tunnel just for review links." />
          <div><Button variant="ghost" className={btn} onClick={() => setChoosing(false)}>Cancel</Button></div>
        </div>
      )}

      {setup.flow && (
        <div className="border-t border-border pt-3" data-testid="share-review-setup">
          <ReviewAddressSetupView setup={setup} ppmHostname={ppmHostname} />
        </div>
      )}
    </section>
  );
}
