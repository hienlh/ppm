import { describe, expect, it } from "bun:test";
import { timingRows, timingSummary, totalMs, uploadMs, type VoiceTimings } from "../../../src/web/lib/voice-message-timings";

/** A 59-second dictation as measured on the dev instance: 12.5 s of Whisper, 4.9 s of Haiku. */
const LONG: VoiceTimings = {
  browserConvertMs: 380, requestMs: 18_600, serverMs: 18_100, receiveMs: 300,
  convertMs: 210, transcribeMs: 12_524, cleanupMs: 4_877, cleaned: true,
};

describe("voice message step timings", () => {
  it("adds the browser's conversion and the request into the total", () => {
    expect(totalMs(LONG)).toBe(18_980);
  });

  it("counts as upload the round trip less the server's work after it read the body", () => {
    // 18.6 s round trip, 17.8 s of server work after the 0.3 s body read.
    expect(uploadMs(LONG)).toBe(800);
  });

  it("falls back to the steps it knows when the server sends no totals", () => {
    const old = { ...LONG, serverMs: undefined, receiveMs: undefined };
    expect(uploadMs(old)).toBe(18_600 - 12_524 - 4_877 - 210);
  });

  it("never reports a negative step", () => {
    expect(uploadMs({ ...LONG, requestMs: 100 })).toBe(0);
  });

  it("keeps the short line to the total, Whisper and Haiku", () => {
    expect(timingSummary(LONG)).toBe("19.0s · Whisper 12.5s · Haiku 4.9s");
    expect(timingSummary(LONG).length).toBeLessThan(45);
  });

  it("says when Haiku did not tidy, in the line and in the details", () => {
    const failed = { ...LONG, cleaned: false, cleanupMs: 45_000 };
    expect(timingSummary(failed)).toContain("Haiku didn't tidy");
    expect(timingRows(failed).find((r) => r.label.startsWith("Claude Haiku"))?.value).toBe("didn't tidy after 45.0s");
  });

  it("lists every step with its seconds, the total last", () => {
    expect(timingRows(LONG)).toEqual([
      { label: "Convert in the browser", value: "0.4s" },
      { label: "Upload and reply", value: "0.8s" },
      { label: "Convert on the host", value: "0.2s" },
      { label: "Whisper (speech to text)", value: "12.5s" },
      { label: "Claude Haiku (tidy-up)", value: "4.9s" },
      { label: "Total", value: "19.0s" },
    ]);
  });

  it("marks the host conversion as unknown from an older server", () => {
    expect(timingRows({ ...LONG, convertMs: undefined })[2]).toEqual({ label: "Convert on the host", value: "—" });
  });
});
