/**
 * The sidebar's Port Forwarding panel: a web server running on this machine (a dev server on
 * port 3000, say) opened from another device, privately over Tailscale or through a public
 * Cloudflare link.
 *
 * Signing in to either service is not done here. The two rows at the top say where each one
 * stands and open its sub-tab of Settings → Remote Access: Set up while something is missing,
 * Manage once it is done. The Cloudflare row is PPM's own domain — a forward over Cloudflare
 * needs no sign-in at all, it gets a temporary trycloudflare.com link.
 *
 * The list is every forward on the machine, not only PPM's: `/api/tunnels` also finds cloudflared
 * processes started elsewhere, which can be stopped here after a confirmation, and PPM's own
 * public link, which cannot (Settings → Remote Access → Public link owns it).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { AppWindow, Check, Copy, ExternalLink, Globe, Loader2, Lock, RefreshCw, Square, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { useWindowStore } from "@/components/floating-window/window-store";
import { AdaptiveDialog } from "@/components/settings/tailscale/tailscale-ui";
import { openRemoteAccess, type RemoteAccessTabId } from "@/components/settings/remote-access/remote-access-tab-store";
import { openWebPreviewTab } from "@/components/web-preview/open-web-preview-tab";
import { namedTunnelApi, type NamedTunnelStatus } from "@/lib/api-named-tunnel";
import { tunnelsApi, type TailscaleAvailability, type TunnelEntry, type TunnelVia } from "@/lib/api-tunnels";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

const POLL_MS = 10_000;

const TRANSPORTS: { via: TunnelVia; label: string; hint: string }[] = [
  { via: "tailscale", label: "Tailscale", hint: "Private: only devices in your tailnet can open it." },
  { via: "cloudflare", label: "Cloudflare", hint: "Public: anyone with the link can open it." },
];

const ICON_BUTTON = "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:cursor-default disabled:opacity-50 md:size-8";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Where one service stands, as its row shows it. `done` turns Set up into Manage. */
interface SetupState { status: string; done: boolean; warn?: boolean }

function tailscaleSetup(t: TailscaleAvailability | null): SetupState {
  if (!t) return { status: "Checking…", done: false };
  return t.available ? { status: t.dnsName, done: true } : { status: t.reason, done: false };
}

/** PPM's own domain on Cloudflare. */
function cloudflareSetup(s: NamedTunnelStatus | "error" | null): SetupState {
  if (!s) return { status: "Checking…", done: false };
  if (s === "error") return { status: "Could not check Cloudflare", done: false, warn: true };
  if (s.certState === "invalid" || s.certState === "mismatch") return { status: "Cloudflare sign-in needed", done: false, warn: true };
  if (s.mode === "named" && s.hostname) {
    // The supervisor leaves a warning when the domain failed and it fell back to a temporary link.
    return s.tunnelWarning
      ? { status: `${s.hostname} is not in use right now`, done: true, warn: true }
      : { status: s.hostname, done: true };
  }
  return { status: "No domain set up", done: false };
}

export function PortForwardingPanel({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [forwards, setForwards] = useState<TunnelEntry[]>([]);
  const [hasFetched, setHasFetched] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [portInput, setPortInput] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleAvailability | null>(null);
  const [named, setNamed] = useState<NamedTunnelStatus | "error" | null>(null);
  /** The transport picked by hand; until then Tailscale whenever this host can use it. */
  const [pickedVia, setPickedVia] = useState<TunnelVia | null>(null);
  const [confirmStop, setConfirmStop] = useState<TunnelEntry | null>(null);
  // Set up and Manage open the Settings window: what was done there shows here as it closes.
  const settingsOpen = useWindowStore((s) => Object.values(s.windows).some((w) => w.kind === "settings"));
  const settingsWasOpen = useRef(settingsOpen);
  const tailscaleReady = tailscale?.available === true;
  const via: TunnelVia = tailscaleReady ? pickedVia ?? "tailscale" : "cloudflare";

  // force bypasses the server's 2 s cache (the refresh button); polls keep the list on screen.
  const fetchForwards = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      setForwards(await tunnelsApi.list(force));
    } catch (e) {
      console.warn("[port-forwarding] failed to fetch", e);
    } finally {
      setHasFetched(true);
      if (force) setRefreshing(false);
    }
  }, []);

  // A read that fails keeps what was last known: a missed poll is not a change of state.
  const fetchSetup = useCallback(() => {
    tunnelsApi.transports()
      .then((t) => setTailscale(t.tailscale))
      .catch(() => setTailscale((t) => t ?? { available: false, reason: "Could not check Tailscale on the host" }));
    namedTunnelApi.status()
      .then((s) => setNamed(s))
      .catch(() => setNamed((s) => s ?? "error"));
  }, []);

  useEffect(() => {
    if (settingsWasOpen.current && !settingsOpen) fetchSetup();
    settingsWasOpen.current = settingsOpen;
  }, [settingsOpen, fetchSetup]);

  useEffect(() => {
    void fetchForwards();
    fetchSetup();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchForwards();
      fetchSetup();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchForwards, fetchSetup]);

  // Both open something in the main area, which the phone's drawer would otherwise cover.
  const openSetup = (tab: RemoteAccessTabId) => {
    openRemoteAccess(tab);
    onNavigate?.();
  };

  const openInTab = (url: string, port: number | null, forwardVia: TunnelVia) => {
    openWebPreviewTab({ url, port, via: forwardVia });
    onNavigate?.();
  };

  const startForward = async (port: number) => {
    setStarting(true);
    setError(null);
    try {
      const res = await tunnelsApi.start(port, via);
      setPortInput("");
      openInTab(res.url, port, res.via);
      await fetchForwards();
    } catch (e) {
      setError(message(e) || `Could not forward port ${port}`);
    } finally {
      setStarting(false);
    }
  };

  const stop = async (t: TunnelEntry) => {
    try {
      await tunnelsApi.stop(t.pid);
      await fetchForwards();
    } catch (e) {
      toast.error(`Could not stop the forward (pid ${t.pid})`, { description: message(e) });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const port = parseInt(portInput, 10);
    if (port >= 1 && port <= 65535) void startForward(port);
    else setError("The port must be a number from 1 to 65535.");
  };

  return (
    <div className="flex h-full flex-col" data-testid="port-forwarding-panel">
      <SidebarHeader icon={Globe} title="Port Forwarding">
        <button
          type="button"
          onClick={() => { void fetchForwards(true); fetchSetup(); }}
          disabled={refreshing}
          aria-label="Refresh"
          title="Refresh"
          className="flex size-11 shrink-0 items-center justify-center rounded text-text-subtle hover:bg-surface-elevated hover:text-foreground disabled:opacity-50 md:size-6"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </button>
      </SidebarHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section aria-label="Sign-in" className="space-y-3 border-b border-border p-3">
          <SetupRow label="Tailscale" state={tailscaleSetup(tailscale)} onOpen={() => openSetup("tailscale")} testId="setup-tailscale" />
          <SetupRow label="Cloudflare" state={cloudflareSetup(named)} onOpen={() => openSetup("public-link")} testId="setup-cloudflare" />
        </section>

        <form onSubmit={handleSubmit} className="space-y-2 border-b border-border p-3">
          <label htmlFor="forward-port" className="block text-xs text-muted-foreground">Port on this machine</label>
          <div className="flex gap-2">
            <div className="flex min-h-11 min-w-0 flex-1 items-center rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 md:min-h-8">
              <span className="shrink-0 pl-2.5 text-xs text-muted-foreground">localhost:</span>
              <input
                id="forward-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65535}
                placeholder="3000"
                value={portInput}
                onChange={(e) => { setPortInput(e.target.value); setError(null); }}
                className="min-w-0 flex-1 bg-transparent py-1.5 pr-2.5 text-sm outline-none placeholder:text-muted-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
            <Button type="submit" disabled={starting || !portInput} className="h-auto min-h-11 shrink-0 cursor-pointer px-3 md:min-h-8">
              {starting ? <Loader2 className="size-4 animate-spin" /> : "Forward"}
            </Button>
          </div>

          <div role="radiogroup" aria-label="Forward over" className="grid grid-cols-2 gap-2">
            {TRANSPORTS.map((t) => {
              const checked = via === t.via;
              return (
                <button
                  key={t.via}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  disabled={t.via === "tailscale" && !tailscaleReady}
                  title={t.via === "tailscale" && tailscale && !tailscale.available ? tailscale.reason : undefined}
                  onClick={() => setPickedVia(t.via)}
                  className={cn(
                    "min-h-11 cursor-pointer rounded-md border px-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 md:min-h-8 md:text-xs",
                    checked ? "border-primary bg-primary/10 font-medium text-primary" : "border-border hover:bg-surface-hover",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">{TRANSPORTS.find((t) => t.via === via)!.hint}</p>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </form>

        <section className="space-y-2 p-3" data-testid="port-forwarding-list">
          <h3 className="text-xs font-medium text-muted-foreground">Forwarded</h3>
          {!hasFetched ? (
            <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : forwards.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
              <p className="text-sm text-muted-foreground md:text-xs">Nothing is forwarded yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">A cloudflared tunnel started outside PPM shows up here too.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {forwards.map((t) => (
                <ForwardRow
                  key={t.pid}
                  forward={t}
                  onOpen={(url) => openInTab(url, t.port, t.via ?? "cloudflare")}
                  onStop={() => (t.source === "external" ? setConfirmStop(t) : void stop(t))}
                  onShowPublicLink={() => openSetup("public-link")}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <AdaptiveDialog open={!!confirmStop} title="Stop a tunnel PPM did not start?" onClose={() => setConfirmStop(null)}>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            This cloudflared (pid {confirmStop?.pid}) was started outside PPM, maybe by another app.
            Stopping it takes {confirmStop?.url ?? "its link"} down for everyone using it.
          </p>
          <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end">
            <Button variant="outline" onClick={() => setConfirmStop(null)} className="min-h-11 cursor-pointer md:min-h-9">Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => { const t = confirmStop; setConfirmStop(null); if (t) void stop(t); }}
              className="min-h-11 cursor-pointer md:min-h-9"
            >
              Stop
            </Button>
          </div>
        </div>
      </AdaptiveDialog>
    </div>
  );
}

function SetupRow({ label, state, onOpen, testId }: { label: string; state: SetupState; onOpen: () => void; testId: string }) {
  return (
    <div className="flex items-center gap-2" data-testid={testId} data-done={state.done ? "true" : "false"}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium md:text-xs">{label}</p>
        <p className="flex items-start gap-1 text-xs text-muted-foreground">
          {state.warn && <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />}
          <span className="min-w-0 wrap-anywhere" data-testid={`${testId}-status`}>{state.status}</span>
        </p>
      </div>
      <Button
        variant={state.done ? "ghost" : "outline"}
        onClick={onOpen}
        className="h-auto min-h-11 shrink-0 cursor-pointer px-3 text-xs md:min-h-8"
      >
        {state.done ? "Manage" : "Set up"}
      </Button>
    </div>
  );
}

function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide", className)}>
      {children}
    </span>
  );
}

function ForwardRow({ forward: t, onOpen, onStop, onShowPublicLink }: {
  forward: TunnelEntry;
  onOpen: (url: string) => void;
  onStop: () => void;
  onShowPublicLink: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isPrivate = t.via === "tailscale";

  const copy = async (url: string) => {
    if (!(await copyToClipboard(url))) { toast.error("Could not copy the link"); return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li className="space-y-1.5 rounded-lg border border-border p-2.5" data-testid="forward-row">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span className="font-mono text-sm font-medium">{t.port != null ? `:${t.port}` : "—"}</span>
          {isPrivate
            ? <Chip className="bg-primary/10 text-primary" title="Only devices in your tailnet can open it">Tailnet</Chip>
            : <Chip className="bg-muted text-muted-foreground" title="Anyone with the link can open it">Public</Chip>}
          {t.source === "external" && <Chip className="bg-muted text-muted-foreground">Started outside PPM</Chip>}
        </div>
        {t.protected ? (
          <Button
            variant="ghost"
            onClick={onShowPublicLink}
            title="PPM's own public link: manage it in Settings → Remote Access"
            className="h-auto min-h-11 shrink-0 cursor-pointer gap-1.5 px-2 text-xs text-muted-foreground md:min-h-8"
          >
            <Lock className="size-3.5" /> Public link
          </Button>
        ) : (
          <button type="button" onClick={onStop} aria-label="Stop" title="Stop" className={cn(ICON_BUTTON, "hover:bg-destructive/10 hover:text-destructive")}>
            <Square className="size-4" />
          </button>
        )}
      </div>

      <div className="flex items-center rounded-md bg-muted pl-2.5">
        <span className={cn("min-w-0 flex-1 truncate text-xs", !t.url && "italic text-muted-foreground")} title={t.url ?? undefined}>
          {t.url ?? "Address not known"}
        </span>
        {t.url && (
          <>
            <button type="button" onClick={() => onOpen(t.url!)} aria-label="Open in a tab" title="Open in a tab" className={ICON_BUTTON}>
              <AppWindow className="size-4" />
            </button>
            <a href={t.url} target="_blank" rel="noopener noreferrer" aria-label="Open in the browser" title="Open in the browser" className={ICON_BUTTON}>
              <ExternalLink className="size-4" />
            </a>
            <button type="button" onClick={() => void copy(t.url!)} aria-label="Copy link" title="Copy link" className={ICON_BUTTON}>
              {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </button>
          </>
        )}
      </div>

      <p className="font-mono text-[10px] text-muted-foreground">pid {t.pid}</p>
    </li>
  );
}
