/**
 * Settings → Remote Access → Public link: PPM's own Cloudflare tunnel, a public https address
 * that opens PPM from anywhere, no Tailscale needed.
 *
 * Two things are read separately. The switch (`/api/tunnel`) only writes config: the supervisor
 * owns cloudflared and applies it as a `retunnel`, so "on" and "serving" are seconds apart and the
 * pane polls faster while they differ. The address is either a temporary trycloudflare one or the
 * user's own domain (`/api/tunnel/named`), set up through the same step machine as the first-run
 * popup, rendered inline while it runs.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, Lock, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { publicTunnelApi, type PublicTunnelStatus } from "@/lib/api-tunnels";
import { namedTunnelApi } from "@/lib/api-named-tunnel";
import { useNamedTunnelSetup } from "@/components/tunnels/named-tunnel/use-named-tunnel-setup";
import { NamedTunnelSetupContent } from "@/components/tunnels/named-tunnel/named-tunnel-setup-content";
import { openSettings } from "../open-settings";
import { AddressRow, Notice } from "../tailscale/tailscale-settings-section";
import { AdaptiveDialog } from "../tailscale/tailscale-ui";

const POLL_MS = 10_000;
/** While the switch is on and no link exists yet: the link usually lands within seconds. */
const STARTING_POLL_MS = 2_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** This page was loaded from that address. */
function onThisAddress(url: string | null): boolean {
  if (!url) return false;
  try { return new URL(url).hostname === window.location.hostname; } catch { return false; }
}

export function PublicLinkPane() {
  const [status, setStatus] = useState<PublicTunnelStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [confirmTemporary, setConfirmTemporary] = useState(false);
  const [switching, setSwitching] = useState(false);
  const named = useNamedTunnelSetup();

  const refresh = useCallback(async () => {
    try {
      setStatus(await publicTunnelApi.status());
      setLoadError(null);
    } catch (e) {
      // Keep the last known state: a failed poll is not a state change.
      setLoadError(message(e));
    }
  }, []);

  // Absent on a server older than the switch, where the tunnel was always on.
  const enabled = status ? (status.enabled ?? true) : false;
  const starting = enabled && !!status && !status.active;

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, starting ? STARTING_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [starting, refresh]);

  useEffect(() => {
    const reload = () => { void refresh(); void named.refreshStatus(); };
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [refresh, named.refreshStatus]);

  const setEnabled = async (next: boolean) => {
    setPending(true);
    setStatus((s) => s && { ...s, enabled: next });
    try {
      await publicTunnelApi.setEnabled(next);
      await refresh();
    } catch (e) {
      setStatus((s) => s && { ...s, enabled: !next });
      toast.error(next ? "Could not turn the public link on" : "Could not turn the public link off", { description: message(e) });
    } finally {
      setPending(false);
    }
  };

  const switchToTemporary = async () => {
    setConfirmTemporary(false);
    setSwitching(true);
    try {
      await namedTunnelApi.disable();
      toast.success("Switched to a temporary address");
      await Promise.all([named.refreshStatus(), refresh()]);
    } catch (e) {
      toast.error("Could not switch to a temporary address", { description: message(e) });
    } finally {
      setSwitching(false);
    }
  };

  if (!status) {
    return (
      <p className="text-sm text-muted-foreground">
        {loadError ? `Could not read the public link's state: ${loadError}` : "Reading the public link's state…"}
      </p>
    );
  }

  const nt = named.status;
  // Unknown until the named status lands: never block on a value that has not been read.
  const authEnabled = nt?.authEnabled ?? true;
  const mode = nt?.mode ?? "quick";
  const hostname = mode === "named" ? nt?.hostname ?? null : null;
  // Turning the domain off kills the connector serving this page, so the temporary link that
  // replaces it could never reach whoever pressed the button.
  const servedByDomain = !!hostname && window.location.hostname === hostname;
  // "ask-domain" is the first-run popup's own question; here the Set up button already answers it.
  const inFlow = named.step.k !== "hidden" && named.step.k !== "ask-domain";
  const fellBack = mode === "named" && nt?.liveMode === "quick";

  return (
    <div className="space-y-6" data-testid="public-link-pane">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Open PPM from anywhere through a public https link, served by Cloudflare. Anyone who has the
        link reaches PPM's sign-in page, so keep the password on. For a link only your own devices can
        open, use Tailscale instead.
      </p>

      <section className="space-y-4 rounded-lg border border-border p-4" data-testid="public-link-switch-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="public-link-switch" className="text-sm font-medium">Public link</Label>
            <p className="text-sm leading-relaxed text-muted-foreground" data-testid="public-link-status">
              {!enabled
                ? "Off."
                : starting
                  ? "On. Waiting for Cloudflare to hand out the link…"
                  : "On. Anyone with the link reaches PPM's sign-in page."}
            </p>
          </div>
          <div className="flex min-h-11 shrink-0 items-center gap-2">
            {(pending || starting) && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <Switch
              id="public-link-switch"
              checked={enabled}
              disabled={pending || (!enabled && !authEnabled)}
              onCheckedChange={(on) => {
                // Turning it off from the link itself cuts this page off mid-click.
                if (!on && onThisAddress(status.url)) setConfirmOff(true);
                else void setEnabled(on);
              }}
            />
          </div>
        </div>

        {enabled && status.url && <AddressRow url={status.url} qrHint="Scan to open PPM on a phone" />}

        {!authEnabled && (
          <Notice icon={<Lock className="size-4" />}>
            <p>
              {enabled
                ? "PPM's password is off while the link is on: anyone who has the link can open PPM. Turn the password on, or the link off."
                : "PPM's password is off. Turn it on first: anyone with the link could otherwise open PPM."}
            </p>
            <Button variant="outline" onClick={() => openSettings("general")} className="min-h-11 cursor-pointer md:min-h-9">Open General</Button>
          </Notice>
        )}
      </section>

      <section className="space-y-3" data-testid="public-link-address">
        <h3 className="text-sm font-medium">Address</h3>
        {inFlow ? (
          <div className="rounded-lg border border-border p-4">
            <NamedTunnelSetupContent step={named.step} t={named} />
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            <AddressOption
              title="Temporary address"
              inUse={mode === "quick"}
              description="A random trycloudflare.com address. It changes every time PPM restarts."
              action={mode === "named" && (
                <Button
                  variant="outline"
                  onClick={() => setConfirmTemporary(true)}
                  disabled={switching || servedByDomain}
                  className="min-h-11 cursor-pointer md:min-h-9"
                >
                  {switching ? <Loader2 className="size-4 animate-spin" /> : "Switch"}
                </Button>
              )}
            />
            <AddressOption
              title="Your own domain"
              inUse={mode === "named"}
              description={hostname
                ? <><span className="break-all font-medium text-foreground">https://{hostname}</span>. It stays the same after a restart.</>
                : "One fixed address on a domain you have on Cloudflare, like ppm.example.com."}
              action={mode === "quick" && authEnabled && (
                <Button onClick={named.answerYes} className="min-h-11 cursor-pointer md:min-h-9">Set up</Button>
              )}
            />
          </div>
        )}

        {!inFlow && mode === "quick" && !authEnabled && (
          <p className="text-xs text-muted-foreground">Turn on PPM's password to use your own domain.</p>
        )}
        {!inFlow && servedByDomain && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            This page is open through your domain, so switching would cut it off before the new
            address could show. Open PPM another way first (Tailscale, or on this machine), then switch.
          </p>
        )}
        {(fellBack || nt?.tunnelWarning) && (
          <Notice icon={<TriangleAlert className="size-4 text-warning" />}>
            {fellBack && <p>PPM could not use your domain and is on a temporary address for now.</p>}
            {nt?.tunnelWarning && <p>{nt.tunnelWarning}</p>}
          </Notice>
        )}
      </section>

      <AdaptiveDialog open={confirmOff} title="Turn off the link you are using?" onClose={() => setConfirmOff(false)}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This page is open at {status.url}. Turning the link off disconnects it; reach PPM another
            way to turn it back on.
          </p>
          <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
            <Button variant="outline" onClick={() => setConfirmOff(false)} className="min-h-11 cursor-pointer md:min-h-9">Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => { setConfirmOff(false); void setEnabled(false); }}
              className="min-h-11 cursor-pointer md:min-h-9"
            >
              Turn off
            </Button>
          </div>
        </div>
      </AdaptiveDialog>

      <AdaptiveDialog open={confirmTemporary} title="Switch to a temporary address?" onClose={() => setConfirmTemporary(false)}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            PPM stops answering at https://{hostname} and gets a new random address instead. Links that
            use your domain stop working until you set it up again.
          </p>
          <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
            <Button variant="outline" onClick={() => setConfirmTemporary(false)} className="min-h-11 cursor-pointer md:min-h-9">Cancel</Button>
            <Button variant="destructive" onClick={() => void switchToTemporary()} className="min-h-11 cursor-pointer md:min-h-9">
              Switch
            </Button>
          </div>
        </div>
      </AdaptiveDialog>
    </div>
  );
}

function AddressOption({ title, description, inUse, action }: {
  title: string;
  description: ReactNode;
  inUse: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-3" data-in-use={inUse || undefined}>
      <div className="min-w-0 flex-[1_1_14rem] space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {inUse && (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">In use</span>
          )}
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
