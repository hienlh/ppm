import { describe, expect, it } from "bun:test";
import {
  autoSendStep, composeVoiceContent, decideVoiceSend, shouldAutoSend, transcriptFailureAction, transcriptFooter,
  transcriptWasEdited, voiceFileName, voiceGate,
} from "../../../src/web/lib/voice-message-compose";
import { splitVoiceMessage } from "../../../src/shared/voice-message";
import { buildMessageWithAttachments } from "../../../src/web/components/chat/build-message-with-attachments";
import { parseVoiceSettings } from "../../../src/web/lib/voice-message-client";
import { addVoiceWord } from "../../../src/web/components/settings/voice-words-editor";
import { voiceBarHeights } from "../../../src/web/components/chat/voice-audio-player";
import type { ChatAttachment } from "../../../src/web/components/chat/message-input";

const voice = { path: "/home/u/.ppm/uploads/ab12-voice-20261120T120000.webm", durationSec: 42, transcript: "OK, sửa Hono middleware đi." };

describe("composeVoiceContent", () => {
  it("puts the voice part last, after the typed text, and splits back to the same parts", () => {
    const content = composeVoiceContent("Lỗi lúc mở tab Git:", voice);
    expect(content.startsWith("Lỗi lúc mở tab Git:\n\n[Voice message (0:42)")).toBe(true);
    expect(splitVoiceMessage(content)).toEqual({ before: "Lỗi lúc mở tab Git:", voice });
  });

  it("is the voice part alone when nothing was typed, and the text alone when there is no voice", () => {
    expect(splitVoiceMessage(composeVoiceContent("  ", voice))).toEqual({ before: "", voice });
    expect(composeVoiceContent("hello", null)).toBe("hello");
  });

  it("survives the attachment markers the chat tab prepends for images", () => {
    const image = { id: "1", name: "shot.png", file: new File([], "shot.png"), isImage: true, serverPath: "/up/shot.png", status: "ready" } as ChatAttachment;
    const sent = buildMessageWithAttachments(composeVoiceContent("see the image", voice), [image]);
    const split = splitVoiceMessage(sent);
    expect(split.voice).toEqual(voice);
    expect(split.before.endsWith("see the image")).toBe(true);
  });
});

describe("voice send gate", () => {
  const draft = (transcript: "processing" | "ready" | "error", upload: "uploading" | "done" | "error", cleaned = true) =>
    ({ transcript, upload, cleaned });

  it("reads the draft's state", () => {
    expect(voiceGate(null)).toBe("none");
    expect(voiceGate(draft("processing", "uploading"))).toBe("transcribing");
    expect(voiceGate(draft("ready", "uploading"))).toBe("uploading");
    expect(voiceGate(draft("ready", "done"))).toBe("ready");
    expect(voiceGate(draft("ready", "error"))).toBe("failed");
    expect(voiceGate(draft("error", "done"))).toBe("failed");
  });

  it("with review on, holds the send while transcribing and sends once the text is there", () => {
    const opts = { reviewBeforeSend: true, cleaned: true, queuedBeforeText: false };
    expect(decideVoiceSend("transcribing", opts)).toBe("hold");
    expect(decideVoiceSend("uploading", opts)).toBe("queue");
    expect(decideVoiceSend("ready", opts)).toBe("send");
    expect(decideVoiceSend("ready", { ...opts, cleaned: false })).toBe("send");
  });

  it("with review off, queues a press made while transcribing, but never sends a raw transcript unread", () => {
    // The server's real answers once the transcript is ready: the setting as it is (off), and
    // whether the clean-up ran. A failed clean-up is cleaned:false with the setting untouched.
    const tidied = { reviewBeforeSend: false, cleaned: true };
    const raw = { reviewBeforeSend: false, cleaned: false };
    expect(decideVoiceSend("transcribing", { ...tidied, queuedBeforeText: false })).toBe("queue");
    expect(decideVoiceSend("ready", { ...tidied, queuedBeforeText: true })).toBe("send");
    expect(decideVoiceSend("ready", { ...raw, queuedBeforeText: true })).toBe("hold");
    // Pressed again once the raw text is on screen: the user has read it.
    expect(decideVoiceSend("ready", { ...raw, queuedBeforeText: false })).toBe("send");
  });

  it("holds a send queued before the text when review was turned on meanwhile", () => {
    expect(decideVoiceSend("ready", { reviewBeforeSend: true, cleaned: true, queuedBeforeText: true })).toBe("hold");
  });

  it("sends a press queued after the text was shown, while only the upload was outstanding", () => {
    const opts = { reviewBeforeSend: true, cleaned: false, queuedBeforeText: false };
    expect(decideVoiceSend("uploading", opts)).toBe("queue");
    expect(decideVoiceSend("ready", opts)).toBe("send");
  });

  it("never sends an emptied transcript as a voice part", () => {
    const opts = { reviewBeforeSend: false, cleaned: true, queuedBeforeText: false, transcriptBlank: true };
    expect(decideVoiceSend("ready", opts)).toBe("hold");
    expect(decideVoiceSend("uploading", opts)).toBe("hold");
  });

  it("never sends a failed voice, and leaves a message without one alone", () => {
    expect(decideVoiceSend("failed", { reviewBeforeSend: false, cleaned: true, queuedBeforeText: true })).toBe("refuse");
    expect(decideVoiceSend("none", { reviewBeforeSend: true, cleaned: false, queuedBeforeText: false })).toBe("send");
  });

  it("sends by itself only with review off, a tidied transcript and the upload done", () => {
    expect(shouldAutoSend("ready", { reviewBeforeSend: false, cleaned: true })).toBe(true);
    expect(shouldAutoSend("ready", { reviewBeforeSend: true, cleaned: true })).toBe(false);
    expect(shouldAutoSend("ready", { reviewBeforeSend: false, cleaned: false })).toBe(false);
    expect(shouldAutoSend("uploading", { reviewBeforeSend: false, cleaned: true })).toBe(false);
  });

  it("waits while the composer cannot send, then sends once, and never twice for one draft", () => {
    const base = { ready: true, draftId: "d1", attemptedId: null, queued: false, blocked: true };
    expect(autoSendStep(base)).toBe("wait");
    expect(autoSendStep({ ...base, blocked: false })).toBe("send");
    expect(autoSendStep({ ...base, blocked: false, attemptedId: "d1" })).toBe("idle");
    expect(autoSendStep({ ...base, blocked: false, queued: true })).toBe("idle");
    expect(autoSendStep({ ...base, blocked: false, ready: false })).toBe("idle");
    expect(autoSendStep({ ...base, blocked: false, attemptedId: "d0" })).toBe("send");
  });

  it("opens the Whisper install only for a missing Whisper, never for voice messages turned off", () => {
    expect(transcriptFailureAction("whisper_missing")).toBe("whisper-missing");
    expect(transcriptFailureAction("voice_messages_off")).toBe("turned-off");
    expect(transcriptFailureAction(undefined)).toBe("failed");
    expect(transcriptFailureAction("transcribe_failed")).toBe("failed");
  });
});

describe("voice draft details", () => {
  it("counts a real change as an edit, not whitespace", () => {
    expect(transcriptWasEdited("sửa hô nô đi", "sửa Hono đi")).toBe(true);
    expect(transcriptWasEdited("sửa Hono đi", " sửa  Hono đi\n")).toBe(false);
    expect(transcriptWasEdited("sửa Hono đi", "")).toBe(false);
  });

  it("names the upload after the recorder's format", () => {
    const at = new Date("2026-11-20T12:34:56.789Z");
    expect(voiceFileName("audio/webm;codecs=opus", at)).toBe("voice-20261120T123456.webm");
    expect(voiceFileName("audio/ogg; codecs=opus", at)).toBe("voice-20261120T123456.ogg");
    expect(voiceFileName("audio/mp4", at)).toBe("voice-20261120T123456.m4a");
    expect(voiceFileName("", at)).toBe("voice-20261120T123456.webm");
  });

  it("writes the footer from the timings", () => {
    expect(transcriptFooter({ transcribeMs: 2800, cleanupMs: 1100, cleaned: true, reviewBeforeSend: true }))
      .toBe("Transcribed 2.8s · tidied 1.1s · read it, then send");
    expect(transcriptFooter({ transcribeMs: 2800, cleanupMs: 0, cleaned: false, reviewBeforeSend: false }))
      .toBe("Transcribed 2.8s · read it, then send");
  });

  it("reads a settings answer with anything missing as off", () => {
    expect(parseVoiceSettings(null)).toEqual({
      enabled: false, reviewBeforeSend: true, words: [], projectWords: [], projectLearned: [], whisperReady: false,
    });
    const view = parseVoiceSettings({ enabled: true, reviewBeforeSend: false, words: ["PPM", 3], projectLearned: [{ word: "Hono", from: "hô nô", at: "x" }, { word: 1 }] });
    expect(view.enabled).toBe(true);
    expect(view.reviewBeforeSend).toBe(false);
    expect(view.words).toEqual(["PPM"]);
    expect(view.projectLearned).toEqual([{ word: "Hono", from: "hô nô", at: "x" }]);
  });

  it("adds a word once, ignoring case and blank input", () => {
    expect(addVoiceWord(["Hono"], "  Bun.serve ")).toEqual(["Hono", "Bun.serve"]);
    expect(addVoiceWord(["Hono"], "hono")).toBeNull();
    expect(addVoiceWord(["Hono"], "   ")).toBeNull();
  });

  it("draws the same bars for the same message", () => {
    const a = voiceBarHeights(12, "/up/a.webm");
    expect(a).toEqual(voiceBarHeights(12, "/up/a.webm"));
    expect(a).not.toEqual(voiceBarHeights(12, "/up/b.webm"));
    expect(a.every((h) => h >= 0.3 && h <= 1)).toBe(true);
  });
});
