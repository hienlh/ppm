/**
 * What the chat draft keeps of the composer's voice message, and what comes back from it: nothing
 * before the upload landed, the chip alone while it was still being transcribed (to be transcribed
 * again), the chip and the transcript once it was there.
 */
import { describe, expect, it } from "bun:test";
import {
  VOICE_INTERRUPTED_MESSAGE, voiceDraftFromStored, voiceDraftToStored,
} from "../../../src/web/lib/voice-draft-persist";
import { parseStoredVoiceDraft } from "../../../src/shared/voice-draft";
import { voiceGate, shouldAutoSend } from "../../../src/web/lib/voice-message-compose";
import type { VoiceDraft } from "../../../src/web/hooks/use-voice-message-draft";

const PATH = "/home/u/.ppm/uploads/1a2b3c4d-voice-20261120T100000.webm";
const TIMINGS = { browserConvertMs: 120, requestMs: 3400, transcribeMs: 2100, cleanupMs: 900, cleaned: true };

function draft(over: Partial<VoiceDraft> = {}, transcript: Partial<VoiceDraft["transcript"]> = {}): VoiceDraft {
  return {
    id: "d1", localUrl: "blob:x", durationSec: 42,
    upload: { status: "done", path: PATH },
    ...over,
    transcript: {
      status: "ready", startedAt: 1, shown: "tidied text", raw: "raw text", cleaned: true,
      transcribeMs: 2100, cleanupMs: 900, timings: TIMINGS, reviewBeforeSend: false,
      ...transcript,
    },
  };
}

describe("voiceDraftToStored", () => {
  it("keeps nothing while the upload is on its way or failed: there is no file to bring back", () => {
    expect(voiceDraftToStored(draft({ upload: { status: "uploading" } }), "x")).toBeNull();
    expect(voiceDraftToStored(draft({ upload: { status: "error" } }), "x")).toBeNull();
    expect(voiceDraftToStored(null, "")).toBeNull();
  });

  it("keeps the recording alone while it is still being transcribed, or when that failed", () => {
    expect(voiceDraftToStored(draft({}, { status: "processing", shown: "" }), "")).toEqual({ path: PATH, durationSec: 42 });
    expect(voiceDraftToStored(draft({}, { status: "error", error: "boom" }), "")).toEqual({ path: PATH, durationSec: 42 });
  });

  it("keeps the box's text as it is now, beside Whisper's, the clean-up's and the timings", () => {
    const stored = voiceDraftToStored(draft({}, { cleanupError: undefined }), "edited by hand");
    expect(stored).toEqual({
      path: PATH, durationSec: 42,
      transcript: {
        text: "edited by hand", shown: "tidied text", raw: "raw text", cleaned: true,
        transcribeMs: 2100, cleanupMs: 900, timings: TIMINGS,
      },
    });
    // The server reads it back unchanged.
    expect(parseStoredVoiceDraft(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("keeps a failed or skipped clean-up", () => {
    const stored = voiceDraftToStored(draft({}, { cleaned: false, cleanupSkipped: true, cleanupError: "Haiku timed out" }), "raw text");
    expect(stored?.transcript).toMatchObject({ cleaned: false, cleanupSkipped: true, cleanupError: "Haiku timed out" });
  });

  it("never keeps the blob URL or the server's review setting", () => {
    const json = JSON.stringify(voiceDraftToStored(draft(), "t"));
    expect(json).not.toContain("blob:");
    expect(json).not.toContain("reviewBeforeSend");
  });
});

describe("voiceDraftFromStored", () => {
  const opts = { id: "r1", remoteSrc: "/api/project/p/chat/uploads/x.webm", now: 1000 };

  it("a saved transcript comes back as the chip and the block, with the edited text in the box", () => {
    const stored = voiceDraftToStored(draft(), "edited by hand")!;
    const { draft: back, text } = voiceDraftFromStored(stored, opts);
    expect(text).toBe("edited by hand");
    expect(back.localUrl).toBeUndefined();
    expect(back.remoteSrc).toBe(opts.remoteSrc);
    expect(back.upload).toEqual({ status: "done", path: PATH });
    expect(back.transcript).toMatchObject({
      status: "ready", shown: "tidied text", raw: "raw text", cleaned: true, initialText: "edited by hand", timings: TIMINGS,
    });
    expect(voiceGate({ transcript: back.transcript.status, upload: back.upload.status, cleaned: back.transcript.cleaned })).toBe("ready");
  });

  it("a restored transcript waits to be read: it never sends itself, even with review off", () => {
    const { draft: back } = voiceDraftFromStored(voiceDraftToStored(draft(), "t")!, opts);
    expect(back.transcript.reviewBeforeSend).toBe(true);
    const gate = voiceGate({ transcript: back.transcript.status, upload: back.upload.status, cleaned: true });
    expect(shouldAutoSend(gate, { reviewBeforeSend: back.transcript.reviewBeforeSend!, cleaned: true })).toBe(false);
  });

  it("no transcript saved: the chip comes back with Transcribe again, and nothing can be sent yet", () => {
    const { draft: back, text } = voiceDraftFromStored({ path: PATH, durationSec: 9 }, opts);
    expect(text).toBe("");
    expect(back.durationSec).toBe(9);
    expect(back.transcript).toMatchObject({ status: "error", interrupted: true, error: VOICE_INTERRUPTED_MESSAGE });
    expect(voiceGate({ transcript: back.transcript.status, upload: back.upload.status, cleaned: false })).toBe("failed");
    // Saving it again changes nothing: still the recording alone.
    expect(voiceDraftToStored(back, text)).toEqual({ path: PATH, durationSec: 9 });
  });
});
