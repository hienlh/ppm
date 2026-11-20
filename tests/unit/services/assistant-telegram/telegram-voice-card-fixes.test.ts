import { describe, expect, it } from "bun:test";
import {
  audioFileExt, voiceCardHtml, voiceFixesHtml, voiceOffHtml, voiceSentHtml, voiceTimingText,
} from "../../../../src/services/assistant-telegram/assistant-telegram-voice-card.ts";

describe("the Telegram voice card's new lines", () => {
  it("names each fix, escaped", () => {
    expect(voiceFixesHtml([{ from: "BPM", to: "PPM" }, { from: "<a>", to: "a&b" }]))
      .toBe("Fixed: <s>BPM</s> → <b>PPM</b> · <s>&lt;a&gt;</s> → <b>a&amp;b</b>");
    expect(voiceFixesHtml([])).toBeNull();
  });

  it("redacts a secret in a fix or a learned word, as the quoted transcript does", () => {
    const key = `sk-ant-api03-${"x".repeat(40)}`;
    expect(voiceFixesHtml([{ from: "pass", to: key }])).not.toContain(key);
    expect(voiceSentHtml("x", { learned: [{ word: key, from: "y" }] })).not.toContain(key);
  });

  it("times each step, and leaves Haiku out when it did not run", () => {
    expect(voiceTimingText({ whisperMs: 4120, haikuMs: 2580 })).toBe("Whisper 4.1 s · Haiku 2.6 s");
    expect(voiceTimingText({ whisperMs: 4120 })).toBe("Whisper 4.1 s");
    // A clean-up that ran is named even when it answered within the millisecond.
    expect(voiceTimingText({ whisperMs: 4120, haikuMs: 0 })).toBe("Whisper 4.1 s · Haiku 0.0 s");
  });

  it("shows fixes only on a cleaned transcript: a replaced one is the user's own words", () => {
    const base = { transcript: "x", withIt: null, fixes: [{ from: "BPM", to: "PPM" }], timing: { whisperMs: 1000, haikuMs: 900 } };
    expect(voiceCardHtml({ ...base, label: "cleaned" })).toContain("Fixed:");
    expect(voiceCardHtml({ ...base, label: "replaced" })).not.toContain("Fixed:");
    expect(voiceCardHtml({ ...base, label: "replaced" })).toContain("Whisper 1.0 s · Haiku 0.9 s");
  });

  it("the Sent note names learned words and where to undo them", () => {
    expect(voiceSentHtml("x", { learned: [{ word: "PPM", from: "BPM" }] }))
      .toContain("Learned: PPM (heard as BPM). Undo in PPM → Settings → Voice.");
    expect(voiceSentHtml("x")).toBe("✅ <b>Sent</b>\n<blockquote>x</blockquote>");
  });

  it("says plainly that voice messages are off, and how to turn them on", () => {
    expect(voiceOffHtml(true)).toContain("Turn them on here");
    expect(voiceOffHtml(false)).toContain("Install Whisper");
  });

  it("stores an audio file under an extension the player reads, or refuses it", () => {
    expect(audioFileExt({ mime_type: "audio/mpeg" })).toBe("mp3");
    expect(audioFileExt({ mime_type: "audio/x-m4a" })).toBe("m4a");
    expect(audioFileExt({ mime_type: "application/octet-stream", file_name: "memo.WAV" })).toBe("wav");
    expect(audioFileExt({ mime_type: "audio/x-flac", file_name: "take.flac" })).toBeNull();
  });
});
