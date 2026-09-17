import { describe, it, expect } from "bun:test";
import {
  parseWhisperText,
  threadCount,
  whisperArgs,
} from "../../../src/services/speech-to-text/whisper-transcribe.service.ts";
import { isInventedLine } from "../../../src/services/speech-to-text/whisper-hallucinations.ts";

/** What this model actually answers for a clip with no speech in it. */
const OUTRO = "Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn";

describe("parseWhisperText", () => {
  it("joins the segment lines into one message", () => {
    expect(parseWhisperText(" Em sửa giúp anh cái hàm này.\n Xong rồi chạy lại bun test.\n")).toBe(
      "Em sửa giúp anh cái hàm này. Xong rồi chạy lại bun test.",
    );
  });

  it("drops whisper's non-speech annotations", () => {
    expect(parseWhisperText("[BLANK_AUDIO]\n Chào em.\n(nhạc nền)\n")).toBe("Chào em.");
  });

  it("is empty for empty output", () => {
    expect(parseWhisperText("\n  \n")).toBe("");
  });

  it("drops a line with no letters in it", () => {
    // A hum transcribes as a bare "." in English, which would put a stray full
    // stop in the chat box.
    expect(parseWhisperText(" .\n Chào em.\n")).toBe("Chào em.");
  });

  it("drops the sentence whisper invents out of non-speech", () => {
    expect(parseWhisperText(` ${OUTRO}\n`)).toBe("");
  });

  it("keeps the real segments either side of an invented one", () => {
    expect(parseWhisperText(` Chào em.\n ${OUTRO}\n Chạy lại bun test nhé.\n`)).toBe(
      "Chào em. Chạy lại bun test nhé.",
    );
  });
});

describe("isInventedLine", () => {
  it("matches the sign-off however it is punctuated or cased", () => {
    expect(isInventedLine(OUTRO)).toBe(true);
    expect(isInventedLine(` ${OUTRO.toLowerCase()}!`)).toBe(true);
    expect(isInventedLine("Cảm ơn các bạn đã theo dõi và hẹn gặp lại.")).toBe(true);
    expect(isInventedLine("cảm ơn các bạn đã theo dõi và hẹn gặp lại")).toBe(true);
  });

  it("matches a reworded sign-off by the channel name in it", () => {
    expect(isInventedLine("Đăng ký kênh Ghiền Mì Gõ nhé các bạn")).toBe(true);
  });

  it("leaves dictated speech alone", () => {
    expect(isInventedLine("Em sửa giúp anh cái hàm này.")).toBe(false);
    expect(isInventedLine("Cảm ơn em nhé.")).toBe(false);
    expect(isInventedLine("")).toBe(false);
  });
});

describe("threadCount", () => {
  it("raises whisper.cpp's default of 4 but stops where the curve flattens", () => {
    expect(threadCount(4)).toBe(4);
    expect(threadCount(24)).toBe(16);
    expect(threadCount(1)).toBe(1);
  });
});

describe("whisperArgs", () => {
  const args = whisperArgs("/bin/whisper-cli", "/tmp/a.wav", "/models/ggml-x.bin", "vi");

  it("always runs with VAD in front of the model", () => {
    // Without it, silence transcribes as an invented Vietnamese sentence.
    expect(args).toContain("--vad");
    expect(args[args.indexOf("--vad-model") + 1]).toEndWith("ggml-silero-v5.1.2.bin");
  });

  it("passes the language and asks for plain text", () => {
    expect(args[args.indexOf("-l") + 1]).toBe("vi");
    expect(args).toContain("-nt");
    expect(args).toContain("-np");
  });
});
