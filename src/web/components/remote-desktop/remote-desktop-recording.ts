/**
 * Screenshot and session recording, both taken from the **canvas** rather than from the wire.
 *
 * That is a deliberate trade. Muxing the access units the host already sent would be lossless
 * and free of CPU cost, but it needs an MP4 muxer in the browser and it would record the rung
 * the host chose rather than what the user was looking at — a mid-recording quality change
 * switches resolution and SPS, which no single-track MP4 can express. `captureStream()` +
 * `MediaRecorder` re-encodes (so it costs the *client* CPU) and in exchange records exactly
 * what was on screen, survives every rung change, and carries the audio track in the same file.
 *
 * `captureStream()` is called with no frame rate on purpose: that makes the stream emit a frame
 * whenever the canvas is drawn to, which is the decoder's own cadence. Passing a number
 * resamples to it, so a 30 fps argument against a 60 fps rung would throw half the frames away
 * and a 60 against a 15 fps rung would triple every one of them.
 */

/** Container/codec preference. VP9 is the best quality per byte that is universally present in
 *  Chromium; H.264-in-MP4 goes first where it exists because it is the one a phone's gallery and
 *  every video editor will open without being converted. */
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/** The first candidate this browser will actually record, or null when none is supported (no
 *  `MediaRecorder` at all — Safari before 14.1, or a locked-down embedded webview). */
export function pickRecordingMime(
  isSupported: (mime: string) => boolean = (m) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find(isSupported) ?? null;
}

/** `video/webm;codecs=vp9,opus` → `webm`. Taken from the MIME the recorder actually accepted,
 *  because a file named `.webm` that holds MP4 bytes is one no player will open. */
export function extensionForMime(mime: string): string {
  return mime.startsWith("video/mp4") ? "mp4" : "webm";
}

/** `ppm-remote-2026-09-11_14-32-08.mp4` — sortable, and with no `:` so it survives Windows. */
export function recordingFileName(ext: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
    + `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  return `ppm-remote-${stamp}.${ext}`;
}

/** Hand a blob to the browser as a download. The object URL is revoked on the next task rather
 *  than immediately: revoking in the same tick can beat the navigation the click starts, which
 *  fails as a "network error" download with nothing in the console. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save the current frame as a PNG. Resolves false when the canvas has no picture yet (a 0×0
 *  canvas, i.e. before the first frame) — `toBlob` on one of those yields a blank image rather
 *  than failing, which would download a file that looks like a bug in the capture. */
export async function saveCanvasScreenshot(canvas: HTMLCanvasElement | null): Promise<boolean> {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return false;
  downloadBlob(blob, recordingFileName("png"));
  return true;
}
