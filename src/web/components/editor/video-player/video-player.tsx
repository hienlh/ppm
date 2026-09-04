import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { newMediaSessionId, rawMediaUrl, stopTranscode, transcodeMediaUrl } from "@/lib/media-url";
import { VideoPlayerControls } from "./video-player-controls";
import { SPEED_STEPS } from "./video-settings-menu";
import { useVideoKeyboardShortcuts, type VideoPlayerActions } from "./use-video-keyboard-shortcuts";
import {
  IDENTITY_TRANSFORM, fittedMaxSize, rotateClockwise, rotateCounterClockwise, toCssTransform, type VideoTransform,
} from "./video-transform";

interface Props {
  filePath: string;
  projectName: string;
  /**
   * `native`: the browser decodes the file itself, streamed by Range requests — seeking
   * is a `currentTime` assignment. `transcode`: ffmpeg pipes a live fragmented MP4 with
   * no duration, so the bar uses ffprobe's duration and a seek restarts the stream at
   * `?start=`; position on screen = start + currentTime.
   */
  mode: "native" | "transcode";
  /** Seconds from ffprobe (transcode mode); native mode reads it from the element. */
  probeDuration?: number | null;
  /** Native decode failed (e.g. HEVC in .mov) — caller may retry through ffmpeg. */
  onNativeError?: () => void;
}

/** Custom player shared by both playback paths so rotation, speed and shortcuts behave the same. */
export function VideoPlayer({ filePath, projectName, mode, probeDuration = null, onNativeError }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Whether the user wants playback. Read after a transcode restart to decide between
  // resuming and staying paused; derived from user actions, not `video.paused`, because
  // the element reports paused while a fresh stream is still loading.
  const wantPlayRef = useRef(true);
  // One id per mounted player: the server replaces (kills) this player's previous
  // ffmpeg job on every seek and stops it when told the player is gone.
  const [sessionId] = useState(newMediaSessionId);

  const [start, setStart] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [nativeDuration, setNativeDuration] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [scrub, setScrub] = useState<number | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [transform, setTransform] = useState<VideoTransform>(IDENTITY_TRANSFORM);
  const [fullscreen, setFullscreen] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);

  const isTranscode = mode === "transcode";
  const src = isTranscode ? transcodeMediaUrl(filePath, projectName, start, sessionId) : rawMediaUrl(filePath, projectName);
  const duration = isTranscode ? probeDuration : nativeDuration;
  const position = scrub ?? (isTranscode ? start + elapsed : elapsed);

  // New source (mount, other file, or transcode restart) → back to loading state.
  useEffect(() => { setElapsed(0); setWaiting(true); setError(null); }, [src]);
  useEffect(() => { setStart(0); setNativeDuration(null); setTransform(IDENTITY_TRANSFORM); }, [filePath, mode]);

  // Element properties survive src changes but not a remount; keep them in sync with state.
  useEffect(() => { const v = videoRef.current; if (v) { v.volume = volume; v.muted = muted; } }, [volume, muted]);
  useEffect(() => { const v = videoRef.current; if (v) v.playbackRate = speed; }, [speed, src]);

  // Leaving the player must stop its ffmpeg job explicitly: a detached <video> keeps its
  // fetch alive until garbage-collected, and a proxy such as Cloudflare Tunnel keeps the
  // origin request open even after the browser has dropped it. Emptying the source aborts
  // the local load; the DELETE tells the server. `isConnected` guards StrictMode's
  // simulated unmount, where the element stays in the DOM and React would not re-apply
  // the src attribute afterwards. `pagehide` covers reload/close, where cleanups never run.
  useEffect(() => {
    const v = videoRef.current;
    const stop = () => { if (isTranscode) stopTranscode(filePath, projectName, sessionId); };
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      if (v && !v.isConnected) {
        v.pause();
        v.removeAttribute("src");
        v.load();
        stop();
      }
    };
  }, [filePath, projectName, isTranscode, sessionId]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Rotated 90°/270° video must be sized against the swapped stage axes.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    const clamped = Math.max(0, duration ? Math.min(t, duration - 0.5) : t);
    setScrub(null);
    if (!isTranscode) { if (v) v.currentTime = clamped; return; }
    // Restarting ffmpeg for a sub-second nudge is wasteful.
    if (Math.abs(clamped - (start + (v?.currentTime ?? 0))) < 0.5) return;
    setStart(clamped);
  }, [duration, isTranscode, start]);

  const actions = useMemo<VideoPlayerActions>(() => ({
    togglePlay: () => {
      const v = videoRef.current;
      if (!v) return;
      wantPlayRef.current = v.paused;
      if (v.paused) void v.play().catch(() => {});
      else v.pause();
    },
    seekBy: (d) => seekTo((isTranscode ? start : 0) + (videoRef.current?.currentTime ?? 0) + d),
    toggleFullscreen: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void rootRef.current?.requestFullscreen?.();
    },
    toggleMute: () => setMuted((m) => !m),
    volumeBy: (d) => { setMuted(false); setVolume((v) => Math.min(1, Math.max(0, Math.round((v + d) * 100) / 100))); },
    speedStep: (dir) => setSpeed((s) => {
      const i = SPEED_STEPS.indexOf(s as typeof SPEED_STEPS[number]);
      return SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, Math.max(0, (i === -1 ? 3 : i) + dir))] ?? 1;
    }),
    rotate: (dir) => setTransform((t) => (dir === 1 ? rotateClockwise(t) : rotateCounterClockwise(t))),
  }), [seekTo, isTranscode, start]);

  const onKeyDown = useVideoKeyboardShortcuts(actions);
  const fitted = fittedMaxSize(transform, box);

  // Retry re-requests the same position; the nudge makes the URL differ so the element reloads.
  const retry = () => { setError(null); setStart((s) => s + 0.001); };

  return (
    <div
      ref={rootRef}
      data-testid="video-player"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex flex-col h-full bg-black outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
    >
      <div
        ref={stageRef}
        className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden"
        onClick={(e) => { rootRef.current?.focus(); if (e.detail === 1) actions.togglePlay(); }}
        onDoubleClick={actions.toggleFullscreen}
      >
        <video
          ref={videoRef}
          src={src}
          autoPlay
          playsInline
          preload={isTranscode ? "auto" : "metadata"}
          style={{ transform: toCssTransform(transform), maxWidth: fitted.maxWidth || undefined, maxHeight: fitted.maxHeight || undefined }}
          onLoadedMetadata={(e) => {
            // Re-apply user settings: a fresh load (seek restart, retry) resets the element.
            const v = e.currentTarget;
            v.playbackRate = speed;
            v.volume = volume;
            v.muted = muted;
            if (!isTranscode && Number.isFinite(v.duration)) setNativeDuration(v.duration);
            if (isTranscode && !wantPlayRef.current) v.pause();
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
          onEnded={() => { setPlaying(false); wantPlayRef.current = false; }}
          onError={() => {
            if (!isTranscode) onNativeError?.();
            else setError("Transcoding failed. ffmpeg may have stopped or the file is corrupt.");
          }}
        />
        {waiting && !error && <Loader2 className="absolute size-8 animate-spin text-white/80 pointer-events-none" />}
        {/* Overlay rather than a replacement tree: the <video> stays mounted so volume,
            mute and speed survive a retry. */}
        {error && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 text-text-secondary p-4 text-center"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm">{error}</p>
            <Button variant="outline" size="sm" className="h-11 px-4" onClick={retry}>Retry</Button>
          </div>
        )}
      </div>

      <VideoPlayerControls
        playing={playing}
        position={position}
        duration={duration}
        volume={volume}
        muted={muted}
        speed={speed}
        transform={transform}
        fullscreen={fullscreen}
        onTogglePlay={actions.togglePlay}
        onScrub={setScrub}
        onSeek={seekTo}
        onVolume={(v) => { setVolume(v); setMuted(v === 0); }}
        onToggleMute={actions.toggleMute}
        onSpeed={setSpeed}
        onRotate={actions.rotate}
        onFlipH={() => setTransform((t) => ({ ...t, flipH: !t.flipH }))}
        onFlipV={() => setTransform((t) => ({ ...t, flipV: !t.flipV }))}
        onResetTransform={() => setTransform(IDENTITY_TRANSFORM)}
        onToggleFullscreen={actions.toggleFullscreen}
      />
    </div>
  );
}
