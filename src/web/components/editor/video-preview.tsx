import { useEffect, useState } from "react";
import { Download, FileWarning, Loader2 } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { extensionOf } from "@/components/os-explorer/can-open-in-ppm";
import { probeMedia, rawMediaUrl, type MediaProbeInfo } from "@/lib/media-url";
import { VideoPlayer } from "./video-player/video-player";
import { NativeVideo } from "@/components/media/native-video";
import { QualityToggle } from "@/components/media/quality-toggle";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { readVideoQuality, writeVideoQuality } from "@/lib/video-quality-pref";
import type { VideoQuality } from "../../../shared/card-files";

/** Containers every browser demuxes natively; anything else goes through ffmpeg. */
const NATIVE_CONTAINERS = new Set(["mp4", "m4v", "webm", "ogg", "ogv", "mov"]);

type Mode =
  | { kind: "native" }
  | { kind: "probing" }
  | { kind: "transcode"; probe: MediaProbeInfo }
  | { kind: "unsupported"; probe: MediaProbeInfo | null };

/**
 * Streams the file straight from its URL so the browser fetches it in byte ranges
 * (instant start, cheap seeking, no whole-file blob in memory). Files the browser
 * cannot decode — AVI, MKV, or an mp4 with HEVC inside — fall back to server-side
 * transcoding when ffmpeg is installed.
 */
export function VideoPreview({ filePath, projectName }: { filePath: string; projectName: string }) {
  const ext = extensionOf(filePath);
  const [mode, setMode] = useState<Mode>(() => (NATIVE_CONTAINERS.has(ext) ? { kind: "native" } : { kind: "probing" }));

  // Reset when a different file is shown in the same tab.
  useEffect(() => {
    setMode(NATIVE_CONTAINERS.has(extensionOf(filePath)) ? { kind: "native" } : { kind: "probing" });
  }, [filePath]);

  useEffect(() => {
    if (mode.kind !== "probing") return;
    let cancelled = false;
    probeMedia(filePath, projectName)
      .then((probe) => {
        if (cancelled) return;
        setMode(probe.transcodable ? { kind: "transcode", probe } : { kind: "unsupported", probe });
      })
      .catch(() => { if (!cancelled) setMode({ kind: "unsupported", probe: null }); });
    return () => { cancelled = true; };
  }, [mode.kind, filePath, projectName]);

  if (mode.kind === "probing") {
    return <div className="flex items-center justify-center h-full"><Loader2 className="size-5 animate-spin text-text-subtle" /></div>;
  }
  if (mode.kind === "transcode") {
    return <VideoPlayer filePath={filePath} projectName={projectName} mode="transcode" probeDuration={mode.probe.duration} />;
  }
  if (mode.kind === "unsupported") {
    return <UnsupportedVideo filePath={filePath} projectName={projectName} probe={mode.probe} />;
  }
  // The browser's own player (`NativeVideo`): its controls behave on a phone, where the
  // hand-drawn ones played and paused on one double tap and had no full screen on iPhone. The
  // custom player stays for a transcoded stream, which has no length for a native seek bar.
  return <NativeWithSmooth filePath={filePath} projectName={projectName} onNativeError={() => setMode({ kind: "probing" })} />;
}

/**
 * A file the browser plays itself, with Original / Smooth. Original streams the file with Range in
 * the browser's own player. Smooth is the same file re-encoded live by the server at ~4 Mbit/s
 * (hardware encoder when there is one), for a phone whose link cannot carry the original; it plays
 * in the transcode player, which seeks by restarting the stream. Smooth needs ffmpeg on the host:
 * without it the choice is not shown. The choice is remembered per device (a phone starts on
 * Smooth, a desktop on Original).
 */
function NativeWithSmooth({ filePath, projectName, onNativeError }: { filePath: string; projectName: string; onNativeError: () => void }) {
  const isMobile = useIsMobile();
  const [quality, setQuality] = useState<VideoQuality>(() => readVideoQuality(isMobile));
  // null: not asked yet; "unavailable": no ffmpeg (or the probe failed), so no Smooth.
  const [probe, setProbe] = useState<MediaProbeInfo | "unavailable" | null>(null);

  useEffect(() => { setProbe(null); }, [filePath]);
  useEffect(() => {
    if (quality !== "smooth" || probe !== null) return;
    let cancelled = false;
    probeMedia(filePath, projectName)
      .then((p) => { if (!cancelled) setProbe(p.transcodable ? p : "unavailable"); })
      .catch(() => { if (!cancelled) setProbe("unavailable"); });
    return () => { cancelled = true; };
  }, [quality, probe, filePath, projectName]);

  const pick = (q: VideoQuality) => { writeVideoQuality(q); setQuality(q); };
  const smoothReady = quality === "smooth" && probe !== null && probe !== "unavailable";
  return (
    <div className="flex h-full flex-col bg-black" data-video-preview={smoothReady ? "smooth" : "original"}>
      {probe !== "unavailable" && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border bg-surface px-2 py-1">
          <QualityToggle value={quality} onChange={pick} smoothPending={quality === "smooth" && probe === null} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        {smoothReady
          ? <VideoPlayer filePath={filePath} projectName={projectName} mode="transcode" quality="smooth" probeDuration={(probe as MediaProbeInfo).duration} />
          : (
            <NativeVideo
              src={rawMediaUrl(filePath, projectName)}
              label={filePath}
              // A native container can still hide a codec the browser lacks (HEVC in .mov);
              // let ffmpeg have a go before giving up.
              onError={onNativeError}
            />
          )}
      </div>
    </div>
  );
}

function UnsupportedVideo({ filePath, projectName, probe }: { filePath: string; projectName: string; probe: MediaProbeInfo | null }) {
  const codecs = [probe?.video?.codec, probe?.audio?.codec].filter(Boolean).join(" + ");
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-text-secondary p-6 text-center">
      <FileWarning className="size-10 text-text-subtle" />
      <p className="text-sm">
        This video cannot be played in the browser{codecs ? ` (${codecs})` : ""}.
      </p>
      <p className="text-xs text-text-subtle max-w-sm">
        Install <code>ffmpeg</code> on the PPM server (e.g. <code>winget install ffmpeg</code>, <code>brew install ffmpeg</code>,{" "}
        <code>apt install ffmpeg</code>) and restart PPM to transcode it on the fly.
      </p>
      <Button asChild variant="outline" size="sm" className="h-11 px-4">
        <a href={`${rawMediaUrl(filePath, projectName)}&download=true`} download>
          <Download className="size-4 mr-2" /> Download file
        </a>
      </Button>
    </div>
  );
}
