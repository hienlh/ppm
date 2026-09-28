/**
 * Master on/off switch for PPM's own public tunnel.
 *
 * The switch only writes config — the supervisor owns the cloudflared process
 * and picks the change up as a `retunnel` — so "switched on" and "actually
 * reachable" are a few seconds apart. The row reports both rather than
 * pretending the toggle is instant, and polls on the same 10s cadence as the
 * tunnel list below it.
 */
import { useCallback, useEffect, useState } from "react";
import { Globe, Loader2 } from "@/lib/icons";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { publicTunnelApi, type PublicTunnelStatus } from "@/lib/api-tunnels";

export function PublicTunnelSwitch() {
  const [status, setStatus] = useState<PublicTunnelStatus | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await publicTunnelApi.status());
    } catch {
      // Keep the last known state — a failed poll is not a state change.
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Nothing to toggle until the first read lands; rendering a default-on switch
  // first would flicker to off on every load of a machine that has it off.
  if (!status) return null;

  // Absent on a server that predates the switch, where the tunnel was
  // unconditional — so absent reads as on, never off.
  const enabled = status.enabled ?? true;
  const starting = enabled && !status.active;

  async function toggle(next: boolean) {
    setPending(true);
    setStatus((s) => (s ? { ...s, enabled: next } : s));
    try {
      await publicTunnelApi.setEnabled(next);
      await refresh();
    } catch (e) {
      setStatus((s) => (s ? { ...s, enabled: !next } : s));
      toast.error(e instanceof Error ? e.message : "Could not change the tunnel setting");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-3 p-3 border-b border-border bg-surface">
      <Globe className="size-4 shrink-0 text-text-secondary" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">Public tunnel</div>
        <p className="text-xs text-text-secondary leading-relaxed truncate">
          {!enabled
            ? "Off — PPM stays reachable on this network only"
            : starting
              ? "Starting…"
              : status.url ?? "On — waiting for a public URL"}
        </p>
      </div>
      {(pending || starting) && <Loader2 className="size-4 shrink-0 animate-spin text-text-subtle" />}
      {/* The control is 20x36; the pseudo-element takes its hit area to 44x60
          so it is tappable on a phone without changing the row's layout. */}
      <Switch
        checked={enabled}
        onCheckedChange={toggle}
        disabled={pending}
        aria-label="Public tunnel"
        className="relative shrink-0 before:absolute before:-inset-3 before:content-['']"
      />
    </div>
  );
}
