/**
 * The voice message a chat draft keeps is user data every device of the user loads, so it is read
 * back only in the shape PPM writes: a stored recording's path, typed fields, held lengths.
 */
import { describe, expect, it } from "bun:test";
import {
  decodeStoredVoiceDraft, parseStoredVoiceDraft, VOICE_DRAFT_MAX_TEXT, type StoredVoiceDraft,
} from "../../../src/shared/voice-draft";

const PATH = "/home/u/.ppm/uploads/1a2b3c4d-voice-20261120T100000.webm";
const TIMINGS = {
  browserConvertMs: 120, requestMs: 3400, serverMs: 3300, receiveMs: 10, convertMs: 80,
  transcribeMs: 2100, cleanupMs: 900, cleaned: true,
};
const FULL: StoredVoiceDraft = {
  path: PATH,
  durationSec: 42,
  transcript: {
    text: "sửa Hono middleware, edited", shown: "sửa Hono middleware", raw: "sửa hono mid lơ wear",
    cleaned: true, transcribeMs: 2100, cleanupMs: 900, timings: TIMINGS,
  },
};

describe("parseStoredVoiceDraft", () => {
  it("reads back a full draft unchanged", () => {
    expect(parseStoredVoiceDraft(JSON.parse(JSON.stringify(FULL)))).toEqual(FULL);
  });

  it("keeps a draft with no transcript (the page went while it was transcribing)", () => {
    expect(parseStoredVoiceDraft({ path: PATH, durationSec: 7 })).toEqual({ path: PATH, durationSec: 7 });
  });

  it("keeps the failure details and the skipped clean-up", () => {
    const value = { path: PATH, durationSec: 3, transcript: { ...FULL.transcript!, cleaned: false, cleanupSkipped: true, cleanupError: "Haiku timed out" } };
    expect(parseStoredVoiceDraft(value)?.transcript).toMatchObject({ cleaned: false, cleanupSkipped: true, cleanupError: "Haiku timed out" });
  });

  it("accepts a Windows uploads path", () => {
    const win = "C:\\Users\\u\\.ppm\\uploads\\voice-20261120T100000.m4a";
    expect(parseStoredVoiceDraft({ path: win, durationSec: 5 })?.path).toBe(win);
  });

  it.each([
    ["a file outside uploads", "/etc/passwd"],
    ["a non-audio file in uploads", "/home/u/.ppm/uploads/notes.txt"],
    ["a file in a folder under uploads", "/home/u/.ppm/uploads/sub/voice.webm"],
    ["a hidden file", "/home/u/.ppm/uploads/.voice.webm"],
    ["a traversal", "/home/u/.ppm/uploads/../ppm.db"],
  ])("refuses %s", (_label, path) => {
    expect(parseStoredVoiceDraft({ path, durationSec: 5 })).toBeNull();
  });

  it.each([
    ["no object", "voice"],
    ["an array", [PATH, 5]],
    ["a numeric path", { path: 5, durationSec: 5 }],
    ["a string duration", { path: PATH, durationSec: "5" }],
    ["a negative duration", { path: PATH, durationSec: -1 }],
    ["an infinite duration", { path: PATH, durationSec: Infinity }],
    ["a path longer than any real one", { path: `/x/uploads/${"a".repeat(5000)}.webm`, durationSec: 5 }],
  ])("refuses %s", (_label, value) => {
    expect(parseStoredVoiceDraft(value)).toBeNull();
  });

  it("drops a mistyped transcript alone, so the chip still comes back to be transcribed again", () => {
    expect(parseStoredVoiceDraft({ path: PATH, durationSec: 5, transcript: { text: 42, shown: "x", cleaned: true, transcribeMs: 1, cleanupMs: 1 } }))
      .toEqual({ path: PATH, durationSec: 5 });
    expect(parseStoredVoiceDraft({ path: PATH, durationSec: 5, transcript: { ...FULL.transcript!, cleaned: "yes" } }))
      .toEqual({ path: PATH, durationSec: 5 });
  });

  it("cuts text past the limit rather than losing the voice", () => {
    const long = "a".repeat(VOICE_DRAFT_MAX_TEXT + 500);
    const parsed = parseStoredVoiceDraft({ ...FULL, transcript: { ...FULL.transcript!, text: long, raw: long, shown: long } });
    expect(parsed?.transcript?.text.length).toBe(VOICE_DRAFT_MAX_TEXT);
    expect(parsed?.transcript?.raw?.length).toBe(VOICE_DRAFT_MAX_TEXT);
    expect(parsed?.transcript?.shown.length).toBe(VOICE_DRAFT_MAX_TEXT);
  });

  it("drops bad timings without dropping the transcript, and unknown keys everywhere", () => {
    const parsed = parseStoredVoiceDraft({
      ...FULL, extra: "x",
      transcript: { ...FULL.transcript!, timings: { ...TIMINGS, requestMs: "slow" }, html: "<b>" },
    });
    expect(parsed?.transcript?.timings).toBeUndefined();
    expect(parsed?.transcript?.text).toBe(FULL.transcript!.text);
    expect(parsed).not.toHaveProperty("extra");
    expect(parsed?.transcript).not.toHaveProperty("html");
  });

  it("keeps the timings when only an optional server figure is wrong", () => {
    const parsed = parseStoredVoiceDraft({ ...FULL, transcript: { ...FULL.transcript!, timings: { ...TIMINGS, serverMs: -3 } } });
    const { serverMs: _dropped, ...rest } = TIMINGS;
    expect(parsed?.transcript?.timings).toEqual(rest);
    expect(parsed?.transcript?.timings).not.toHaveProperty("serverMs");
  });
});

describe("decodeStoredVoiceDraft", () => {
  it("reads the stored column, and anything unreadable as no voice", () => {
    expect(decodeStoredVoiceDraft(JSON.stringify(FULL))).toEqual(FULL);
    expect(decodeStoredVoiceDraft(null)).toBeNull();
    expect(decodeStoredVoiceDraft("")).toBeNull();
    expect(decodeStoredVoiceDraft("{not json")).toBeNull();
    expect(decodeStoredVoiceDraft(JSON.stringify({ path: "/etc/passwd", durationSec: 1 }))).toBeNull();
  });
});
