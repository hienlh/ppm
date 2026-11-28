import { useEffect, useRef, useState } from "react";
import { api, getAuthToken } from "@/lib/api-client";
import { Download, Loader2, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { PHONE_ICON_CONTROL_SIZE, TEXT_BUTTON } from "@/lib/control-size";
import { useCardFileViewer } from "@/stores/card-file-viewer-store";
import { NativeVideo } from "@/components/media/native-video";
import { ZoomableImage } from "@/components/media/zoomable-image";
import { formatFileSize, type CardFile, type CardFileSmoothState, type VideoQuality } from "../../../../shared/card-files";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { readVideoQuality, writeVideoQuality } from "@/lib/video-quality-pref";
import { QualityToggle } from "@/components/media/quality-toggle";

/**
 * One report-card file, full screen over the app: the page a Telegram card's link opens
 * (`/card-file/<id>`), and what a card's Open button shows.
 *
 * The original plays as it is, whatever its size: a video streams from `/api/card-files/<id>`
 * with Range (it starts at once and seeks with one small request), a picture is shown from the
 * same URL, a PDF is shown inline. The token rides in the query string because `<video>` and
 * `<img>` cannot send a header; the server takes `?token=` on that one route, which names an id,
 * never a path. Download is a plain link the server answers as an attachment, so even a large
 * clip never sits in the page's memory.
 */

/** The bytes URL of a card file, with the session token for `<video>`, `<img>` and links. */
export function cardFileUrl(id: string, opts: { download?: boolean; smooth?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (opts.download) params.set("download", "1");
  if (opts.smooth) params.set("variant", "smooth");
  const token = getAuthToken();
  if (token) params.set("token", token);
  const q = params.toString();
  return `/api/card-files/${encodeURIComponent(id)}${q ? `?${q}` : ""}`;
}

export function CardFileViewer() {
  const id = useCardFileViewer((s) => s.id);
  const close = useCardFileViewer((s) => s.close);
  const [file, setFile] = useState<CardFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [smooth, setSmooth] = useState<CardFileSmoothState>("none");
  const isMobile = useIsMobile();
  // What this device chose last (a phone starts on Smooth, a desktop on Original).
  const [quality, setQuality] = useState<VideoQuality>(() => readVideoQuality(isMobile));
  // Where the playing copy is, so a switch of copy carries on from there.
  const progress = useRef({ time: 0, playing: false });
  const [resume, setResume] = useState<{ at: number; play: boolean } | null>(null);

  useEffect(() => {
    setFile(null);
    setError(null);
    setPdfUrl(null);
    setSmooth("none");
    setResume(null);
    progress.current = { time: 0, playing: false };
    if (!id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // While the smooth copy is being made, ask again every few seconds.
    const load = (first: boolean) => api.get<{ file: CardFile; smooth?: CardFileSmoothState }>(`/api/card-files/${encodeURIComponent(id)}/info`)
      .then((res) => {
        if (!live) return;
        if (first) setFile(res.file);
        const state = res.smooth ?? "none";
        setSmooth(state);
        if (state === "pending") timer = setTimeout(() => load(false), 5000);
      })
      .catch((e: Error) => { if (live && first) setError(e.message || "This file could not be opened"); });
    void load(true);
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [id]);

  const pick = (q: VideoQuality) => {
    writeVideoQuality(q);
    setResume({ at: progress.current.time, play: progress.current.playing });
    setQuality(q);
  };
  // The copy that plays: Smooth only once it exists; until then the original.
  const playing: VideoQuality = quality === "smooth" && smooth === "ready" ? "smooth" : "original";
  // When the smooth copy becomes ready while this device wants it, it takes over where the original was.
  const lastPlaying = useRef<VideoQuality>(playing);
  useEffect(() => {
    if (lastPlaying.current !== playing) {
      lastPlaying.current = playing;
      setResume({ at: progress.current.time, play: progress.current.playing });
    }
  }, [playing]);

  // A PDF is drawn from a blob: the bytes route's `sandbox` CSP stops the browser's PDF viewer.
  useEffect(() => {
    if (!file || file.kind !== "pdf") return;
    let url: string | null = null;
    let live = true;
    fetch(cardFileUrl(file.id))
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((b) => { if (!live) return; url = URL.createObjectURL(new Blob([b], { type: "application/pdf" })); setPdfUrl(url); })
      .catch(() => { if (live) setError("The PDF could not be loaded"); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [file]);

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, close]);

  if (!id) return null;
  return (
    <div
      role="dialog" aria-modal="true" aria-label={file ? file.name : "File"}
      className="fixed inset-0 z-[200] flex flex-col bg-background"
      data-card-file-viewer={file?.kind ?? "loading"}
    >
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text-primary" title={file?.name}>{file?.name ?? "Loading…"}</div>
          {file && <div className="text-xs text-text-subtle">{playing === "smooth" ? "Smooth copy, about 4 Mbit/s" : `${formatFileSize(file.size)} · original, as the manager attached it`}</div>}
        </div>
        {file?.kind === "video" && smooth !== "none" && (
          <QualityToggle value={quality} onChange={pick} smoothPending={smooth === "pending"} />
        )}
        {file && (
          <Button asChild variant="outline" size="sm" className={TEXT_BUTTON}>
            <a href={cardFileUrl(file.id, { download: true })} download={file.name} data-card-file-download>
              <Download className="size-3.5" /><span className="max-md:sr-only">Download</span>
            </a>
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" className={PHONE_ICON_CONTROL_SIZE} onClick={close} aria-label="Close" data-card-file-close>
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/90">
        {error && <p className="px-4 text-center text-sm text-white" role="alert">{error}</p>}
        {!error && !file && <Loader2 className="size-5 animate-spin text-white" />}
        {file?.kind === "video" && (
          <NativeVideo
            src={cardFileUrl(file.id, { smooth: playing === "smooth" })}
            autoPlay={resume ? resume.play : true}
            startAt={resume?.at}
            onProgress={(time, isPlaying) => { progress.current = { time, playing: isPlaying }; }}
            label={file.name}
          />
        )}
        {file?.kind === "image" && <ZoomableImage src={cardFileUrl(file.id)} alt={file.name} />}
        {file?.kind === "pdf" && (pdfUrl ? <iframe src={pdfUrl} title={file.name} className="size-full bg-white" /> : <Loader2 className="size-5 animate-spin text-white" />)}
        {file?.kind === "other" && (
          <div className="px-6 text-center text-sm text-white">
            <p>This file has no preview in the browser.</p>
            <p className="mt-1 text-white/70">Use Download to save it.</p>
          </div>
        )}
      </div>
    </div>
  );
}
