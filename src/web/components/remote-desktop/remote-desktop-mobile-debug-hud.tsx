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
 * - decoder status/error — WebCodecs failing silently would show up here.
 *
 * Rip out freely once root-caused: this file + the `getBinaryMessageCount`/`getFrameCount`
 * fields on `use-remote-desktop-connection.ts` (which just forwards the decoder's own).
 */
import { useEffect, useState } from "react";
import type { RemoteDesktopConnState } from "./use-remote-desktop-connection";
import type { DecoderStatus } from "./use-h264-canvas-decoder";

const POLL_INTERVAL_MS = 250;

export interface RemoteDesktopMobileDebugHudProps {
  connState: RemoteDesktopConnState;
  decoderStatus: DecoderStatus;
  decoderErrorMessage: string | null;
  getBinaryMessageCount: () => number;
  getFrameCount: () => number;
}

export function RemoteDesktopMobileDebugHud({
  connState,
  decoderStatus,
  decoderErrorMessage,
  getBinaryMessageCount,
  getFrameCount,
}: RemoteDesktopMobileDebugHudProps) {
  const [counts, setCounts] = useState({ binary: 0, frames: 0 });

  useEffect(() => {
    const id = setInterval(() => {
      setCounts({ binary: getBinaryMessageCount(), frames: getFrameCount() });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [getBinaryMessageCount, getFrameCount]);

  return (
    <div
      className="pointer-events-none absolute left-1 top-1 z-50 rounded bg-black/60 px-1.5 py-1 font-mono text-[10px] leading-tight text-lime-300"
      data-testid="remote-desktop-mobile-debug"
    >
      <div>conn: {connState}</div>
      <div>ws bin msgs: {counts.binary}</div>
      <div>decoder frames: {counts.frames}</div>
      <div>decoder: {decoderStatus}{decoderErrorMessage ? ` — ${decoderErrorMessage}` : ""}</div>
    </div>
  );
}
