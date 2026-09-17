import { useCallback, useEffect, useState } from "react";
import { Globe, Loader2, Plus, Square } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { namedTunnelApi, type NamedTunnelStatus } from "@/lib/api-named-tunnel";

interface Props {
  /** Called whenever the named-tunnel status is (re)loaded so the parent can adapt its copy. */
  onStatus: (status: NamedTunnelStatus) => void;
  /** Port the public URL is served on, so a temporary tunnel can target the same thing. */
  publicPort: number | null;
  /** Called when a temporary link appears or goes away. */
  onTempUrl: (url: string | null) => void;
}

interface TunnelEntry {
  pid: number;
  port: number | null;
  url: string | null;
  source: "app" | "ppm" | "external";
  protected: boolean;
}

/**
 * Custom-domain row of the share card.
 *
 * Deliberately does NOT offer "switch back to a temporary link": that kills the
 * connector serving the very page the button lives on, so the user never sees
 * the replacement URL. A temporary link is offered as an ADDITION instead —
 * a second quick tunnel onto the same port, for one-off sharing without handing
 * out the permanent hostname. Turning the domain off entirely stays in the
 * Tunnel Manager, where it can warn about exactly this.
 */
export function CloudShareNamedTunnelRow({ onStatus, publicPort, onTempUrl }: Props) {
  const [status, setStatus] = useState<NamedTunnelStatus | null>(null);
  const [temp, setTemp] = useState<TunnelEntry | null>(null);
  const [busy, setBusy] = useState<"add" | "stop" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const findTemp = useCallback((list: TunnelEntry[], namedUrl: string | null) => {
    return list.find((t) =>
      t.source === "ppm" && !t.protected && t.port === publicPort && t.url && t.url !== namedUrl,
    ) ?? null;
  }, [publicPort]);

  const load = useCallback(async () => {
    try {
      const s = await namedTunnelApi.status();
      setStatus(s);
      onStatus(s);
      const list = await api.get<TunnelEntry[]>("/api/tunnels").catch(() => [] as TunnelEntry[]);
      const found = findTemp(list, s.hostname ? `https://${s.hostname}` : null);
      setTemp(found);
      onTempUrl(found?.url ?? null);
    } catch { /* share card degrades to the plain view */ }
  }, [onStatus, onTempUrl, findTemp]);

  useEffect(() => { void load(); }, [load]);

  const addTemp = useCallback(async () => {
    if (!publicPort) return;
    setBusy("add"); setError(null);
    try {
      const res = await api.post<{ port: number; url: string }>("/api/tunnels", { port: publicPort });
      setTemp({ pid: 0, port: publicPort, url: res.url, source: "ppm", protected: false });
      onTempUrl(res.url);
      void load(); // pick up the real pid so Stop works
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create a temporary link");
    } finally { setBusy(null); }
  }, [publicPort, onTempUrl, load]);

  const stopTemp = useCallback(async () => {
    if (!temp?.pid) return;
    setBusy("stop"); setError(null);
    try {
      await api.del(`/api/tunnels/${temp.pid}`);
      setTemp(null);
      onTempUrl(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not stop the temporary link");
    } finally { setBusy(null); }
  }, [temp?.pid, onTempUrl]);

  if (!status || status.authEnabled === false || !status.hostname) return null;
  if ((status.liveMode ?? status.mode) !== "named") return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-1.5 min-w-0">
          <Globe className="size-3 text-primary shrink-0" />
          <span className="text-foreground truncate">Your domain · {status.hostname}</span>
        </div>
        <button
          onClick={temp ? stopTemp : addTemp}
          disabled={busy !== null || !publicPort}
          className="shrink-0 min-h-11 px-2.5 flex items-center gap-1 text-xs rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50"
          title={temp ? "Stop the temporary link" : "Also expose a temporary link for one-off sharing"}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" />
            : temp ? <><Square className="size-3" /> Stop temp link</>
            : <><Plus className="size-3" /> Temp link</>}
        </button>
      </div>
      {status.tunnelWarning && (
        <p className="text-[11px] text-amber-500 leading-relaxed">{status.tunnelWarning}</p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
