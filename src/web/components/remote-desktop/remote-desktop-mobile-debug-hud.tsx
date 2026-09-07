/**
 * TEMPORARY debug overlay for diagnosing "video frozen on mobile" (desktop works, same
 * `useRemoteDesktopConnection`/`useH264CanvasDecoder`). Polls the ref-backed counters those
 * hooks expose ~4x/sec (a render dependency on every frame/message would defeat the point of
 * keeping them refs) so the user can read off, live on the phone:
 *
 * - connState — did the WS connection itself drop?
 * - WS binary messages received — do access units stop ARRIVING (server-side: eviction,
 *   capture death, backpressure drop) or keep arriving?
 * - decoder frames output — if messages keep arriving but this stalls, decode/draw is the
 *   problem, not the network.
 * - decoder status/error — a PERMANENT failure (recovery exhausted or impossible).
 * - last decode error + which frame it happened at, and how many times the decoder has
 *   auto-recovered — the real WebCodecs message survives here even when recovery succeeds and
 *   `decoderErrorMessage` above never shows anything.
 *
 * Rip out freely once root-caused: this file + the getter fields on
 * `use-remote-desktop-connection.ts` (which just forward the decoder's own).
 */
import { useEffect, useState } from "react";
import type { RemoteDesktopConnState } from "./use-remote-desktop-connection";
import type { DecoderStatus, LastDecoderError } from "./use-h264-canvas-decoder";

const POLL_INTERVAL_MS = 250;

export interface RemoteDesktopMobileDebugHudProps {
  connState: RemoteDesktopConnState;
  decoderStatus: DecoderStatus;
  decoderErrorMessage: string | null;
  getBinaryMessageCount: () => number;
  getFrameCount: () => number;
  getLastDecoderError: () => LastDecoderError | null;
  getRecoveredCount: () => number;
}

export function RemoteDesktopMobileDebugHud({
  connState,
  decoderStatus,
  decoderErrorMessage,
  getBinaryMessageCount,
  getFrameCount,
  getLastDecoderError,
  getRecoveredCount,
}: RemoteDesktopMobileDebugHudProps) {
  const [stats, setStats] = useState<{ binary: number; frames: number; recovered: number; lastError: LastDecoderError | null }>(
    { binary: 0, frames: 0, recovered: 0, lastError: null },
  );

  useEffect(() => {
    const id = setInterval(() => {
      setStats({
        binary: getBinaryMessageCount(),
        frames: getFrameCount(),
        recovered: getRecoveredCount(),
        lastError: getLastDecoderError(),
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [getBinaryMessageCount, getFrameCount, getLastDecoderError, getRecoveredCount]);

  return (
    <div
      className="pointer-events-none absolute left-1 top-1 z-50 max-w-[70vw] rounded bg-black/60 px-1.5 py-1 font-mono text-[10px] leading-tight text-lime-300"
      data-testid="remote-desktop-mobile-debug"
    >
      <div>conn: {connState}</div>
      <div>ws bin msgs: {stats.binary}</div>
      <div>decoder frames: {stats.frames}</div>
      <div>decoder: {decoderStatus}{decoderErrorMessage ? ` — ${decoderErrorMessage}` : ""}</div>
      <div>recovered: {stats.recovered}</div>
      {stats.lastError && (
        <div className="break-words">
          last err @{stats.lastError.frameIndex}: {stats.lastError.message}
        </div>
      )}
    </div>
  );
}
