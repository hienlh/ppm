/**
 * Settings → Remote Access → Tailscale: PPM at a private address on the tailnet,
 * `https://<name>.<tailnet>.ts.net`, served from this machine by a Tailscale Service.
 *
 * Most of the setup belongs to the tailnet's admin console (it decides which machines may
 * host a service), so the pane reads it back instead: a checklist that says what is missing
 * and links to the page that fixes it. It is re-read while anything is pending and whenever
 * the window regains focus, which is when someone comes back from that console.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, ExternalLink, Lock, QrCode, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api-client";
import { tailscaleApi } from "@/lib/api-tailscale";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { openSettings } from "../open-settings";
import { TailscaleSetupSteps } from "./tailscale-setup-steps";
import { TailscaleSignInDialog } from "./tailscale-sign-in-dialog";
import { AdaptiveDialog, CopyableCode, ExternalButton } from "./tailscale-ui";
import {
  blockingSetupStep,
  currentSetupStep,
  serviceNameProblem,
  TAILSCALE_ADMIN,
  type TailscaleLoginSnapshot,
  type TailscaleSettingsState,
} from "../../../../shared/tailscale-setup";

const POLL_MS = 4000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Something is pending that only a later reading shows: a sign-in, the admin console, an approval. */
function needsPolling(s: TailscaleSettingsState): boolean {
  return s.login.state === "starting" || s.login.state === "waiting"
    || currentSetupStep(s) !== null
    || (s.enabled && !s.service.approved);
}

/** This page was loaded from the service's own address. */
function onThisAddress(url: string | null): boolean {
  if (!url) return false;
  try { return new URL(url).hostname === window.location.hostname; } catch { return false; }
}

function addressStatus(s: TailscaleSettingsState): string {
  if (!s.enabled) return "Off.";
  if (s.backendState !== "Running") return "On, but this machine is not connected to Tailscale.";
  if (!s.service.pointsAtPpm) return "On, but Tailscale is not serving it right now.";
  if (!s.service.approved) return "On, waiting for an admin to approve this machine.";
  return "On. Open it from any device signed in to your tailnet.";
}

export function TailscaleSettingsSection() {
  const [state, setState] = useState<TailscaleSettingsState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [name, setName] = useState("");
  // Readings overlap (an event, a focus and a poll at once): only the newest may land.
  const generation = useRef(0);
  const renaming = useRef<Promise<void> | null>(null);

  const apply = useCallback((next: TailscaleSettingsState) => {
    generation.current++;
    setState(next);
    setLoadError(null);
  }, []);

  const patchLogin = useCallback((login: TailscaleLoginSnapshot) => {
    generation.current++;
    setState((s) => s && { ...s, login });
  }, []);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await tailscaleApi.state();
      if (mine === generation.current) { setState(next); setLoadError(null); }
    } catch (e) {
      if (mine === generation.current) setLoadError(message(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const reload = () => void load();
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("tailscale:changed", reload);
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("tailscale:changed", reload);
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const polling = !!state && needsPolling(state);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const savedName = state?.service.name ?? "";
  useEffect(() => { setName(savedName); }, [savedName]);

  // A finished sign-in closes its dialog; any other outcome stays up to be read.
  const loginState = state?.login.state;
  useEffect(() => {
    if (signInOpen && loginState === "success") {
      setSignInOpen(false);
      toast.success("Signed in to Tailscale");
    }
  }, [signInOpen, loginState]);

  const startSignIn = async () => {
    // Before opening: a "success" left from an earlier sign-in would close the dialog at once.
    patchLogin({ state: "starting", url: null, message: null });
    setSignInOpen(true);
    try {
      patchLogin(await tailscaleApi.login());
    } catch (e) {
      patchLogin({ state: "error", url: null, message: message(e) });
    }
  };

  const cancelSignIn = async () => {
    setSignInOpen(false);
    try { patchLogin(await tailscaleApi.cancelLogin()); } catch { /* the next reading shows it */ }
  };

  const nameProblem = serviceNameProblem(name);

  const rename = () => {
    if (!state || name === state.service.name || nameProblem) return;
    renaming.current = (async () => {
      setBusy(true);
      try {
        apply(await tailscaleApi.setService({ name }));
      } catch (e) {
        toast.error("Could not rename the address", { description: message(e) });
        setName(state.service.name);
      } finally {
        setBusy(false);
      }
    })();
  };

  const setEnabled = async (on: boolean, replace = false) => {
    // A click on the switch blurs the name field first, which starts a rename.
    await renaming.current;
    setBusy(true);
    try {
      apply(await tailscaleApi.setService(on ? { enabled: true, replace } : { enabled: false }));
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: unknown } | null)?.code : undefined;
      if (on && code === "conflict") setConflict(true);
      else toast.error(on ? "Could not turn the address on" : "Could not turn the address off", { description: message(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <p className="text-sm text-muted-foreground">
        {loadError ? `Could not read Tailscale's state: ${loadError}` : "Reading Tailscale's state…"}
      </p>
    );
  }

  const blocked = blockingSetupStep(state) !== null;
  const connected = state.backendState === "Running";
  const canTurnOn = state.authEnabled && !blocked && !nameProblem;
  const allDone = currentSetupStep(state) === null;
  const steps = (
    <TailscaleSetupSteps
      state={state}
      onRefresh={() => void load()}
      onSignIn={() => void startSignIn()}
      onShowSignIn={() => setSignInOpen(true)}
    />
  );

  return (
    <div className="space-y-6" data-testid="tailscale-settings">
      <p className="text-sm leading-relaxed text-muted-foreground">
        Reach PPM at a private https address from any device signed in to your tailnet. Nothing
        is opened to the internet, and PPM still asks for its password.
      </p>

      <section className="space-y-4 rounded-lg border border-border p-4" data-testid="tailscale-address">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="tailscale-address-switch" className="text-sm font-medium">Private address</Label>
            <p className="text-sm leading-relaxed text-muted-foreground" data-testid="tailscale-address-status">{addressStatus(state)}</p>
          </div>
          <div className="flex min-h-11 shrink-0 items-center">
            <Switch
              id="tailscale-address-switch"
              checked={state.enabled}
              disabled={busy || (!state.enabled && !canTurnOn)}
              onCheckedChange={(on) => {
                // Turning it off from the address itself cuts this page off mid-click.
                if (!on && onThisAddress(state.service.url)) setConfirmOff(true);
                else void setEnabled(on);
              }}
            />
          </div>
        </div>

        {state.enabled && state.service.url
          ? <AddressRow url={state.service.url} />
          : (
            <div className="space-y-1.5">
              <Label htmlFor="tailscale-service-name" className="text-xs text-muted-foreground">Address</Label>
              <div
                className={cn(
                  "flex min-h-11 items-center rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
                  nameProblem && "border-destructive",
                )}
              >
                <input
                  id="tailscale-service-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  onBlur={rename}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  disabled={busy || state.enabled}
                  aria-invalid={!!nameProblem}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoComplete="off"
                  className="w-20 min-w-20 flex-1 bg-transparent py-2 pl-3 text-sm outline-none"
                />
                <span className="min-w-0 truncate pr-3 text-sm text-muted-foreground">.{state.dnsSuffix ?? "your-tailnet.ts.net"}</span>
              </div>
              <p className={cn("text-xs", nameProblem ? "text-destructive" : "text-muted-foreground")}>
                {nameProblem ?? (state.enabled
                  ? "Turn the address off to rename it."
                  : "The address keeps this name when the machine is renamed.")}
              </p>
            </div>
          )}

        {!state.enabled && !state.authEnabled && (
          <Notice icon={<Lock className="size-4" />}>
            <p>PPM's password is off. Turn it on first: anyone in your tailnet could otherwise open PPM.</p>
            <Button variant="outline" onClick={() => openSettings("general")} className="min-h-11 cursor-pointer md:min-h-9">Open General</Button>
          </Notice>
        )}
        {!state.enabled && state.authEnabled && blocked && (
          <p className="text-xs text-muted-foreground">Finish the setup below to turn it on.</p>
        )}
        {state.enabled && connected && !state.service.pointsAtPpm && (
          <Notice icon={<TriangleAlert className="size-4 text-warning" />}>
            <p>Tailscale is not serving this address right now.</p>
            <Button variant="outline" onClick={() => void setEnabled(true)} disabled={busy} className="min-h-11 cursor-pointer md:min-h-9">Apply again</Button>
          </Notice>
        )}
        {state.enabled && connected && state.service.pointsAtPpm && !state.service.approved && (
          <ApprovalNotice state={state} />
        )}
      </section>

      {allDone ? (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">Setup: every step is done</summary>
          <div className="pt-2">{steps}</div>
        </details>
      ) : (
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Setup</h3>
          {steps}
        </section>
      )}

      <TailscaleSignInDialog
        open={signInOpen}
        login={state.login}
        osUser={state.osUser}
        onRetry={() => void startSignIn()}
        onCancel={() => void cancelSignIn()}
        onClose={() => setSignInOpen(false)}
      />

      <AdaptiveDialog open={confirmOff} title="Turn off the address you are using?" onClose={() => setConfirmOff(false)}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This page is open at {state.service.url}. Turning the address off disconnects it; reach PPM
            another way to turn it back on.
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

      <AdaptiveDialog open={conflict} title={`Replace svc:${state.service.name}?`} onClose={() => setConflict(false)}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            On this machine, svc:{state.service.name} already
            serves <code className="text-xs text-foreground">{state.service.target ?? "something else"}</code>.
            Replacing it points the address at PPM, and what it served stops answering there.
          </p>
          <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
            <Button variant="outline" onClick={() => setConflict(false)} className="min-h-11 cursor-pointer md:min-h-9">Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => { setConflict(false); void setEnabled(true, true); }}
              className="min-h-11 cursor-pointer md:min-h-9"
            >
              Replace
            </Button>
          </div>
        </div>
      </AdaptiveDialog>
    </div>
  );
}

const ICON_BUTTON = "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground";

/** An address with copy, QR code and open; the Public link pane shows its URL with it too. */
export function AddressRow({ url, qrHint = "Scan with a phone that is signed in to your tailnet" }: { url: string; qrHint?: string }) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const copy = async () => {
    if (!(await copyToClipboard(url))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center rounded-md border border-border bg-muted pl-3" data-testid="tailscale-address-url">
        <span className="min-w-0 flex-1 truncate text-sm">{url}</span>
        <button type="button" onClick={() => void copy()} aria-label="Copy address" title="Copy address" className={ICON_BUTTON}>
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </button>
        <button
          type="button"
          onClick={() => setShowQr((v) => !v)}
          aria-label="Show QR code"
          aria-pressed={showQr}
          title="Show QR code"
          className={cn(ICON_BUTTON, showQr && "text-foreground")}
        >
          <QrCode className="size-4" />
        </button>
        <a href={url} target="_blank" rel="noopener noreferrer" aria-label="Open address" title="Open address" className={ICON_BUTTON}>
          <ExternalLink className="size-4" />
        </a>
      </div>
      {showQr && (
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-lg p-3" style={{ backgroundColor: "#ffffff", colorScheme: "light" }}>
            <QRCodeSVG value={url} size={168} bgColor="#ffffff" fgColor="#000000" level="L" style={{ display: "block" }} />
          </div>
          <p className="text-xs text-muted-foreground">{qrHint}</p>
        </div>
      )}
    </div>
  );
}

/** Advertised and waiting: what the admin has to do, and how to never have to again. */
function ApprovalNotice({ state }: { state: TailscaleSettingsState }) {
  const svc = `svc:${state.service.name}`;
  const device = state.device?.name || "this machine";
  const tag = state.device?.tags[0] ?? "tag:ppm";
  const autoApprove = `"autoApprovers": {\n  "services": {\n    "${svc}": ["${tag}"]\n  }\n}`;
  return (
    <Notice icon={<TriangleAlert className="size-4 text-warning" />}>
      <p>
        {state.service.defined
          ? <>Waiting for approval. In <b>Services</b>, open {svc} and approve {device} under Service hosts.</>
          : <>Waiting for the service. Create {svc} in <b>Services</b> (the last step below), then approve {device} as its host.</>}
      </p>
      <ExternalButton href={TAILSCALE_ADMIN.services}>Open services</ExternalButton>
      <p className="pt-1">To approve machines with this tag automatically, add this to your access controls:</p>
      <CopyableCode code={autoApprove} />
    </Notice>
  );
}

export function Notice({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-md border border-border bg-muted px-4 py-3">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1 space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}
