/**
 * WebRTC (WHEP) video painted into the same `<canvas>` the WebCodecs path draws to.
 *
 * Painting into the canvas rather than showing a `<video>` is deliberate: every other part of
 * the viewer — the scale modes in `remote-desktop-view-style.ts`, coordinate mapping in
 * `remote-desktop-coords.ts`, the `MediaRecorder` in `use-remote-desktop-recorder.ts`, the
 * stats overlay — is built on one canvas, and giving it a second rendering surface to reason
 * about would touch all of them for no user-visible gain. The cost is one hardware-accelerated
 * `drawImage` per frame.
 *
 * Why this path exists at all: `VideoDecoder` is **secure-context only**. Measured in one
 * browser at one moment, it is `undefined` on `http://192.168.98.96:3210` and present on
 * `http://127.0.0.1:3210` — so the WebCodecs viewer cannot start on a plain-HTTP LAN origin,
 * which is how PPM is most often reached from a phone or tablet. `RTCPeerConnection` has no
 * such restriction and works on both.
 *
 * The handshake is non-trickle: ICE gathering is allowed to finish before the offer is posted,
 * so one request carries every candidate and there is no PATCH channel to keep open. It costs
 * a few hundred milliseconds at connect and removes a whole signalling path.
 */
import { useCallback, useRef, useState } from "react";
import { getAuthToken } from "@/lib/api-client";
import type { DecoderStatus } from "./use-h264-canvas-decoder";

/** MediaMTX answers 404 until the publisher's first packet lands, and a quality change
 *  respawns that publisher — so the handshake retries rather than failing the viewer. */
const WHEP_RETRY_MS = 400;
const WHEP_RETRY_LIMIT = 25;   // ~10s, comfortably past ffmpeg's ~400ms respawn

/** How long ICE gets once the answer is in. The media is UDP straight to the host's interface
 *  addresses, which a viewer on the Cloudflare tunnel has no route to — and measured in
 *  Chromium, with no candidate reachable `connectionState` only turns `failed` after 15 s, a
 *  quarter-minute of black screen before the caller can try anything else. A path that works
 *  connects long before this. */
export const CONNECT_DEADLINE_MS = 6_000;

export interface UseWebrtcCanvasVideoOptions {
  /** Called at most once per `start()`, when this path cannot carry the picture: the browser has
   *  no WebRTC, the handshake was refused or never produced a stream, ICE did not connect within
   *  `CONNECT_DEADLINE_MS`, or a connection that was up failed. */
  onFailure?: () => void;
}

export interface UseWebrtcCanvasVideoResult {
  status: DecoderStatus;
  errorMessage: string | null;
  /** Run (or re-run) the WHEP handshake against a PPM path such as
   *  `/api/remote-desktop/whep/<ticket>`. Safe to call again on a respawn. */
  start: (whepPath: string) => void;
  stop: () => void;
  getFrameCount: () => number;
  /** Bytes received on the video track, for the stats overlay. WebRTC counts these for us. */
  getTotalBytes: () => number;
  frameSize: { width: number; height: number };
}

export function useWebrtcCanvasVideo(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  { onFailure }: UseWebrtcCanvasVideoOptions = {},
): UseWebrtcCanvasVideoResult {
  const [status, setStatus] = useState<DecoderStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const frameCountRef = useRef(0);
  const bytesRef = useRef(0);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  // A ref, so a new callback each render does not make `start` a new function.
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;

  const teardown = useCallback(() => {
    generationRef.current += 1;
    if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
    if (deadlineRef.current) { clearTimeout(deadlineRef.current); deadlineRef.current = null; }
    try { pcRef.current?.close(); } catch { /* already closed */ }
    pcRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
      video.remove();
      videoRef.current = null;
    }
    ctxRef.current = null;
  }, []);

  const stop = useCallback(() => {
    teardown();
    setStatus("idle");
    setErrorMessage(null);
  }, [teardown]);

  const start = useCallback((whepPath: string) => {
    teardown();
    const generation = generationRef.current;
    const stale = () => generation !== generationRef.current;
    let failed = false;
    const fail = (message: string, kind: DecoderStatus = "error") => {
      if (stale() || failed) return;
      failed = true;
      setStatus(kind);
      setErrorMessage(message);
      onFailureRef.current?.();
    };

    if (typeof RTCPeerConnection === "undefined") {
      fail("This browser has no WebRTC support.", "unsupported");
      return;
    }

    // Hidden, but attached: a detached element is not guaranteed to run
    // `requestVideoFrameCallback`, and `display:none` lets a browser stop decoding entirely.
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;               // host audio has its own path; a muted element may autoplay
    video.playsInline = true;
    video.setAttribute("aria-hidden", "true");
    video.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    videoRef.current = video;

    const paint = () => {
      if (stale()) return;
      const canvas = canvasRef.current;
      if (canvas && video.videoWidth > 0) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          // Inside the size guard: one setState per resolution change, not per frame.
          setFrameSize({ width: video.videoWidth, height: video.videoHeight });
        }
        if (!ctxRef.current) ctxRef.current = canvas.getContext("2d");
        ctxRef.current?.drawImage(video, 0, 0, canvas.width, canvas.height);
        frameCountRef.current += 1;
      }
      schedule();
    };
    // `requestVideoFrameCallback` fires once per *decoded* frame, so the canvas never repaints
    // a picture that has not changed. rAF is the fallback for browsers without it and repaints
    // at display rate instead, which is wasteful but correct.
    const schedule = () =>
      typeof video.requestVideoFrameCallback === "function"
        ? video.requestVideoFrameCallback(() => paint())
        : requestAnimationFrame(() => paint());

    const pc = new RTCPeerConnection({ iceServers: [] });
    pcRef.current = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (e) => {
      const stream = new MediaStream();
      stream.addTrack(e.track);
      video.srcObject = stream;
      void video.play().catch(() => { /* autoplay is allowed for a muted element */ });
      schedule();
    };
    pc.onconnectionstatechange = () => {
      if (stale()) return;
      if (pc.connectionState === "connected") {
        if (deadlineRef.current) { clearTimeout(deadlineRef.current); deadlineRef.current = null; }
        setStatus("ready");
        setErrorMessage(null);
      }
      if (pc.connectionState === "failed") fail("The WebRTC connection failed.");
    };

    statsTimerRef.current = setInterval(async () => {
      if (stale() || !pcRef.current) return;
      try {
        const report = await pcRef.current.getStats();
        report.forEach((r: any) => {
          if (r.type === "inbound-rtp" && r.kind === "video") bytesRef.current = r.bytesReceived ?? 0;
        });
      } catch { /* the connection is going away */ }
    }, 1000);

    void (async () => {
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await waitForIceGathering(pc);
        if (stale()) return;

        const token = getAuthToken();
        const answer = await postOfferWithRetry(whepPath, pc.localDescription!.sdp, token, stale);
        if (stale()) return;
        if (!answer) {
          fail("The host's WebRTC relay never produced a stream.");
          return;
        }
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        if (stale() || pc.connectionState === "connected") return;
        deadlineRef.current = setTimeout(() => {
          deadlineRef.current = null;
          if (pc.connectionState !== "connected") fail("The WebRTC connection did not come up.");
        }, CONNECT_DEADLINE_MS);
      } catch (e) {
        fail((e as Error).message);
      }
    })();
  }, [canvasRef, teardown]);

  return {
    status, errorMessage, start, stop,
    getFrameCount: () => frameCountRef.current,
    getTotalBytes: () => bytesRef.current,
    frameSize,
  };
}

/** Resolve once the browser has gathered every candidate, so one POST carries them all. */
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState !== "complete") return;
      pc.removeEventListener("icegatheringstatechange", done);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", done);
    // A candidate that never arrives must not hang the viewer; what has been gathered by then
    // is enough on a LAN or a tailnet, where the host candidate is the one that wins anyway.
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", done); resolve(); }, 2000);
  });
}

/** POST the offer, retrying while the relay has no publisher yet. Returns the SDP answer. */
async function postOfferWithRetry(
  whepPath: string, offer: string, token: string | null, stale: () => boolean,
): Promise<string | null> {
  for (let attempt = 0; attempt < WHEP_RETRY_LIMIT; attempt++) {
    if (stale()) return null;
    const res = await fetch(whepPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "x-ppm-client": "web",
      },
      body: offer,
    });
    if (res.ok) return await res.text();
    // 404 is "the stream is not up yet" and is the expected answer for the first few hundred
    // milliseconds. Anything else is a real refusal — auth, a dead ticket — and retrying it
    // would just hide the reason.
    if (res.status !== 404 && res.status !== 502) {
      throw new Error(`the host refused the WebRTC handshake (${res.status})`);
    }
    await new Promise((r) => setTimeout(r, WHEP_RETRY_MS));
  }
  return null;
}
