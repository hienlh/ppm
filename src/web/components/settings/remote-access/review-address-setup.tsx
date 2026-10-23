/**
 * Setting a domain up for the review address: Cloudflare sign-in when there is none or it cannot
 * be used, the zone, the hostname, then `POST /api/share-host/setup`. Shared by Settings → Remote
 * Access → Review links and the Share dialog, which show it in place of their address choices
 * while it runs. Cloudflare sign-in is PPM's own (`/api/tunnel/named/login`), whose progress
 * arrives as the same `tunnel:login_*` events.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { namedTunnelApi, type LoginState } from "@/lib/api-named-tunnel";
import { shareHostApi, type ShareHostApplied, type ShareHostStatus } from "@/lib/api-share-host";
import { NamedTunnelLoginStep } from "@/components/tunnels/named-tunnel/named-tunnel-login-step";
import { NamedTunnelHostnameField } from "@/components/tunnels/named-tunnel/named-tunnel-hostname-field";
import { buildHostname, validateHostname } from "@/components/tunnels/named-tunnel/hostname-validation";
import { namedTunnelCopy } from "@/components/tunnels/named-tunnel/named-tunnel-copy";

const DEFAULT_PREFIX = "share";
const btn = "min-h-11 cursor-pointer md:min-h-9";

/** `named`: a tunnel of the review address's own; `shared`: a second hostname on PPM's tunnel. */
export type DomainMode = "named" | "shared";

type SetupFlow =
  /** The saved Cloudflare sign-in cannot be used; signing in again moves it aside, so ask first. */
  | { k: "relogin"; mode: DomainMode; reason: "invalid" | "mismatch" }
  | { k: "login"; mode: DomainMode; url: string | null; slow: boolean }
  | { k: "zone"; mode: DomainMode }
  | { k: "hostname"; mode: DomainMode; zone: string; prefix: string; error?: string }
  | { k: "submitting"; mode: DomainMode; hostname: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Toast a change the server saved, saying so when the supervisor could not apply it yet. */
export function reportApplied(applied: ShareHostApplied, done: string): void {
  if (applied.applied) toast.success(done);
  else toast.warning(`${done} — not applied yet`, { description: applied.message });
}

export interface ReviewAddressSetup {
  /** The step on screen, or null when no setup runs. */
  flow: SetupFlow | null;
  /** Set a domain up on `mode`, signing in to Cloudflare first when needed. */
  begin: (mode: DomainMode) => void;
  cancel: () => void;
  cancelLogin: () => void;
  /** Move the unusable sign-in aside and sign in again. */
  relogin: (mode: DomainMode) => void;
  setPrefix: (prefix: string) => void;
  submit: () => Promise<void>;
}

/** `onDone` runs once a setup is saved and the status read again. */
export function useReviewAddressSetup(
  status: ShareHostStatus | null, refresh: () => Promise<void>, onDone?: () => void,
): ReviewAddressSetup {
  const [flow, setFlow] = useState<SetupFlow | null>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;

  const hostnameError = useCallback((hostname: string, zone: string): string | undefined => {
    const check = validateHostname(hostname, zone);
    if (!check.ok) return check.reason;
    if (hostname === status?.ppmTunnel.hostname) return "That is PPM's own address — pick another prefix";
    return undefined;
  }, [status?.ppmTunnel.hostname]);

  const loadZone = useCallback((mode: DomainMode) => {
    setFlow({ k: "zone", mode });
    shareHostApi.zone()
      .then(({ zone }) => {
        const current = status?.hostname;
        const prefix = current?.endsWith(`.${zone}`) ? current.slice(0, -(zone.length + 1)) : DEFAULT_PREFIX;
        setFlow((f) => (f?.k === "zone" ? { k: "hostname", mode, zone, prefix } : f));
      })
      .catch((e) => {
        setFlow(null);
        toast.error("Could not read your Cloudflare domain", { description: message(e) });
      });
  }, [status?.hostname]);

  const onLoginState = useCallback((mode: DomainMode, state: LoginState, detail: string | null) => {
    if (state === "slow") setFlow((f) => (f?.k === "login" ? { ...f, slow: true } : f));
    if (state === "success") { void refresh(); loadZone(mode); }
    if (state === "timeout" || state === "error") {
      setFlow(null);
      toast.error(state === "timeout" ? "The Cloudflare sign-in link expired" : "Cloudflare sign-in failed", {
        description: detail ?? undefined,
      });
    }
    if (state === "cancelled") setFlow(null);
  }, [loadZone, refresh]);

  const loginMode = flow?.k === "login" ? flow.mode : null;
  useEffect(() => {
    if (!loginMode) return;
    const onUrl = (e: Event) => {
      const url = ((e as CustomEvent).detail as { url?: unknown })?.url;
      if (typeof url === "string") setFlow((f) => (f?.k === "login" ? { ...f, url } : f));
    };
    const onState = (e: Event) => {
      const detail = (e as CustomEvent).detail as { state?: LoginState; message?: string | null };
      if (detail?.state) onLoginState(loginMode, detail.state, detail.message ?? null);
    };
    window.addEventListener("tunnel:login_url", onUrl);
    window.addEventListener("tunnel:login_state", onState);
    return () => {
      window.removeEventListener("tunnel:login_url", onUrl);
      window.removeEventListener("tunnel:login_state", onState);
    };
  }, [loginMode, onLoginState]);

  const startLogin = (mode: DomainMode, relogin: boolean) => {
    setFlow({ k: "login", mode, url: null, slow: false });
    // `relogin` moves the unusable cert aside for a fresh sign-in.
    namedTunnelApi.login(relogin)
      .then((snap) => {
        if (snap.url) setFlow((f) => (f?.k === "login" ? { ...f, url: snap.url } : f));
        onLoginState(mode, snap.state, snap.message);
      })
      .catch((e) => {
        setFlow(null);
        toast.error("Could not start the Cloudflare sign-in", { description: message(e) });
      });
  };

  const begin = (mode: DomainMode) => {
    if (!status) return;
    if (status.certState === "ok") { loadZone(mode); return; }
    if (status.certState === "invalid" || status.certState === "mismatch") {
      setFlow({ k: "relogin", mode, reason: status.certState });
      return;
    }
    startLogin(mode, false);
  };

  const cancelLogin = () => {
    setFlow(null);
    void namedTunnelApi.cancelLogin().catch(() => {});
  };

  const setPrefix = (prefix: string) => {
    setFlow((f) => (f?.k === "hostname" ? { ...f, prefix, error: hostnameError(buildHostname(prefix, f.zone), f.zone) } : f));
  };

  const submit = async () => {
    const f = flowRef.current;
    if (f?.k !== "hostname") return;
    const hostname = buildHostname(f.prefix, f.zone);
    const error = hostnameError(hostname, f.zone);
    if (error) { setFlow({ ...f, error }); return; }
    setFlow({ k: "submitting", mode: f.mode, hostname });
    try {
      const result = await shareHostApi.setup(f.mode, hostname);
      setFlow(null);
      reportApplied(result.applied, `Review address set to https://${result.hostname}`);
      await refresh();
      onDone?.();
    } catch (e) {
      setFlow({ ...f, error: message(e) });
    }
  };

  return {
    flow, begin, cancel: () => setFlow(null), cancelLogin, relogin: (mode) => startLogin(mode, true), setPrefix, submit,
  };
}

/** The setup's current step; nothing when no setup runs. */
export function ReviewAddressSetupView({ setup, ppmHostname }: { setup: ReviewAddressSetup; ppmHostname: string | null }) {
  const { flow } = setup;
  if (!flow) return null;
  switch (flow.k) {
    case "relogin":
      return (
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium">{namedTunnelCopy.needsRelogin.title}</h4>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {flow.reason === "mismatch" ? namedTunnelCopy.needsRelogin.certMismatch : namedTunnelCopy.needsRelogin.certInvalid}
            </p>
          </div>
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button variant="outline" onClick={setup.cancel} className={btn}>Cancel</Button>
            <Button onClick={() => setup.relogin(flow.mode)} className={btn}>{namedTunnelCopy.needsRelogin.action}</Button>
          </div>
        </div>
      );
    case "login":
      return <NamedTunnelLoginStep url={flow.url} slow={flow.slow} onCancel={setup.cancelLogin} />;
    case "zone":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading your Cloudflare domain…
        </p>
      );
    case "submitting":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          <span>Setting up <span className="break-all">https://{flow.hostname}</span>… This takes a few seconds.</span>
        </p>
      );
    case "hostname":
      return (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void setup.submit(); }}>
          <div>
            <h4 className="text-sm font-medium">
              {flow.mode === "named" ? "Review address on its own tunnel" : "Review address on PPM's tunnel"}
            </h4>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {flow.mode === "named"
                ? "PPM creates a Cloudflare tunnel for review links and points this name at it."
                : `PPM adds this name to its tunnel, next to ${ppmHostname ? `https://${ppmHostname}` : "its public link"}.`}
            </p>
          </div>
          <NamedTunnelHostnameField zone={flow.zone} prefix={flow.prefix} error={flow.error} onChange={setup.setPrefix} />
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button type="button" variant="outline" onClick={setup.cancel} className={btn}>Cancel</Button>
            <Button type="submit" className={btn} data-testid="review-links-submit">Set up</Button>
          </div>
        </form>
      );
  }
}
