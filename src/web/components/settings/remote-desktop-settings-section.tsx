/**
 * Remote Desktop settings: the WebRTC relay, which is an optional download.
 *
 * Without it the viewer streams H.264 over the WebSocket and decodes with WebCodecs, which
 * works — except that `VideoDecoder` is secure-context only, so on a plain-HTTP LAN origin
 * (how a phone or tablet usually reaches PPM) it cannot start at all. With the relay installed
 * the host serves WebRTC instead, which has no such restriction. Nothing else changes: the
 * relay repackages the stream ffmpeg already encoded and never re-encodes it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Monitor, Loader2, Download, Trash2, Check } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api-client";

interface RelayJob {
  receivedBytes: number;
  totalBytes: number;
  done: boolean;
  error: string | null;
}

interface RelayStatus {
  installed: boolean;
  path?: string;
  source?: "bundled" | "system";
  pinnedVersion: string;
  /** False when the release publishes no build for this platform/architecture. */
  available: boolean;
  job: RelayJob | null;
}

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

export function RemoteDesktopSettingsSection() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<RelayStatus>("/api/remote-desktop/relay"));
    } catch {
      // A status that cannot be read leaves the pane on "not installed", which is the thing
      // the user can act on anyway.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Poll only while a download is running: the byte count is the only sign of progress.
  const installing = !!status?.job && !status.job.done;
  useEffect(() => {
    if (!installing) return;
    pollRef.current = setTimeout(() => void load(), 700);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [installing, status, load]);

  const install = async () => {
    setBusy(true);
    try {
      await api.post("/api/remote-desktop/relay/install");
      await load();
    } catch (e) {
      toast.error("Could not start the download", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally { setBusy(false); }
  };

  const uninstall = async () => {
    setBusy(true);
    try {
      await api.post("/api/remote-desktop/relay/uninstall");
      await load();
    } catch (e) {
      toast.error("Could not remove the relay", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally { setBusy(false); }
  };

  const job = status?.job ?? null;
  const percent = job && job.totalBytes > 0
    ? Math.round((job.receivedBytes / job.totalBytes) * 100)
    : null;
  const insecure = typeof window !== "undefined" && !window.isSecureContext;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">WebRTC relay</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Streams the desktop over WebRTC instead of a WebSocket. It repackages the video this
            host already encoded — it never re-encodes, so the picture and the CPU cost are
            unchanged.
          </p>
        </div>

        {insecure && (
          // The reason most people will end up on this pane, so it says so plainly rather than
          // leaving them to discover it as a broken viewer.
          <p className="rounded-md bg-muted px-4 py-3 text-xs leading-relaxed">
            You are reading this over plain HTTP. Browsers only expose the WebCodecs video
            decoder on HTTPS or localhost, so <strong>Remote Desktop cannot show a picture on
            this address</strong> without the relay. Installing it fixes that; so does reaching
            PPM through its HTTPS tunnel.
          </p>
        )}

        {!status?.available && !status?.installed && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            MediaMTX publishes no build for this platform. You can install it yourself and put
            <code className="mx-1 rounded bg-muted px-1 py-0.5">mediamtx</code>
            on this host's PATH — PPM generates its own configuration either way.
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 text-sm">
            {status?.installed
              ? <Check className="size-4 text-emerald-500" />
              : <Monitor className="size-4 text-muted-foreground" />}
            <span>
              {status?.installed
                ? status.source === "system"
                  ? "Installed on this host (not by PPM)"
                  : `Installed — MediaMTX ${status.pinnedVersion}`
                : "Not installed"}
            </span>
          </div>

          <div className="flex flex-wrap gap-2 sm:ml-auto">
            {!status?.installed && status?.available && (
              <Button onClick={install} disabled={busy || installing} className="min-h-11 px-4">
                {installing
                  ? <><Loader2 className="size-4 animate-spin" />Downloading{percent !== null ? ` ${percent}%` : ""}</>
                  : <><Download className="size-4" />Install</>}
              </Button>
            )}
            {status?.installed && status.source === "bundled" && (
              <Button variant="outline" onClick={uninstall} disabled={busy || installing} className="min-h-11 px-4">
                <Trash2 className="size-4" />Remove
              </Button>
            )}
          </div>
        </div>

        {installing && job && (
          <p className="text-xs text-muted-foreground">
            {mb(job.receivedBytes)}{job.totalBytes > 0 ? ` of ${mb(job.totalBytes)}` : ""}
          </p>
        )}
        {job?.error && <p className="text-xs text-destructive">{job.error}</p>}
        {status?.path && (
          <p className="text-xs text-muted-foreground break-all">{status.path}</p>
        )}
      </section>

      <Separator />

      <section className="space-y-2">
        <h3 className="text-sm font-medium">What changes when it is on</h3>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground leading-relaxed">
          <li>The picture works on a plain-HTTP LAN address, not only over HTTPS or localhost.</li>
          <li>A lost packet costs one retransmission instead of stalling the whole stream.</li>
          <li>Keyboard, mouse, clipboard and host audio keep using the same WebSocket.</li>
          <li>Video leaves this host on its own UDP port, protected by per-session credentials.</li>
        </ul>
      </section>
    </div>
  );
}
