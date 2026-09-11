/**
 * Records the viewer's canvas (and the session audio, when it is on) to a file the browser
 * downloads on stop. See `remote-desktop-recording.ts` for why the canvas is the source.
 *
 * Chunks are kept in memory until stop, which is the honest limit of this approach: a long
 * recording is a long array of blobs. `MAX_RECORDING_MS` stops it by itself rather than letting
 * a session left recording overnight grow until the tab is killed — a file that stops after two
 * hours is recoverable, a tab that dies takes everything with it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  downloadBlob, extensionForMime, pickRecordingMime, recordingFileName,
} from "./remote-desktop-recording";

/** Two hours. Long enough for any real session, short of the point where the blob array is the
 *  problem (~2 GB at a 1440p60 rung). */
export const MAX_RECORDING_MS = 2 * 60 * 60 * 1000;

export interface UseRemoteDesktopRecorderResult {
  /** True while recording. */
  recording: boolean;
  /** Whole seconds since the recording started; 0 when idle. Drives the toolbar's timer. */
  elapsedSec: number;
  /** null when this browser has no `MediaRecorder` support at all — the UI hides the control
   *  rather than offering a button that cannot work. */
  supported: boolean;
  /** Start, or stop-and-download. Safe to call in either state. */
  toggle: () => void;
}

export function useRemoteDesktopRecorder(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  /** Extra tracks to mux in — the session's audio, when it is playing. Read at start time. */
  getAudioTracks?: () => MediaStreamTrack[],
): UseRemoteDesktopRecorderResult {
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const mime = useRef<string | null>(null);
  if (mime.current === null) mime.current = pickRecordingMime();

  const stop = useCallback(() => {
    // `stop()` fires `dataavailable` then `onstop`, which is where the download happens — so
    // this only asks; it does not assemble the file itself.
    recorderRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    const canvas = canvasRef.current;
    const mimeType = mime.current;
    if (!canvas || !mimeType || recorderRef.current) return;
    // No fps argument: follow the canvas's own draw cadence (see the module header).
    const stream = canvas.captureStream();
    for (const track of getAudioTracks?.() ?? []) stream.addTrack(track);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      return; // the MIME was supported but this stream's tracks are not; nothing to report
    }
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];
      recorderRef.current = null;
      setRecording(false);
      setElapsedSec(0);
      // A recorder stopped before any frame was drawn has nothing to save, and an empty file
      // is worse than no file: it looks like the feature ran and lost the recording.
      if (blob.size > 0) downloadBlob(blob, recordingFileName(extensionForMime(mimeType)));
    };
    // One second per chunk rather than one blob at the end: a tab that crashes mid-recording
    // still has everything up to the last second in memory for `onstop` to assemble, and the
    // allocation pattern stays flat instead of one giant buffer at the finish.
    recorder.start(1_000);
    recorderRef.current = recorder;
    setRecording(true);
    setElapsedSec(0);
  }, [canvasRef, getAudioTracks]);

  const toggle = useCallback(() => {
    if (recorderRef.current) stop(); else start();
  }, [start, stop]);

  useEffect(() => {
    if (!recording) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      const ms = Date.now() - startedAt;
      setElapsedSec(Math.floor(ms / 1000));
      if (ms >= MAX_RECORDING_MS) stop();
    }, 1_000);
    return () => clearInterval(id);
  }, [recording, stop]);

  // A viewer closed mid-recording must still save what it has: without this the recorder is
  // garbage-collected with the chunks and the whole recording is silently lost.
  useEffect(() => () => { recorderRef.current?.stop(); }, []);

  return { recording, elapsedSec, supported: mime.current !== null, toggle };
}
