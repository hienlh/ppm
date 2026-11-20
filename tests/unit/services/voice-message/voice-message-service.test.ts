import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../../src/services/config.service.ts";
import type { VoiceContext, VoiceContextInput } from "../../../../src/services/voice-message/voice-context.ts";
import type { VoiceMessageError } from "../../../../src/services/voice-message/voice-message-errors.ts";
import {
  learnFromEdit, processVoiceMessage, type VoiceServiceDeps,
} from "../../../../src/services/voice-message/voice-message.service.ts";
import { readVoiceSettings, updateVoiceSettings } from "../../../../src/services/voice-message/voice-settings.ts";
import type { ProjectConfig } from "../../../../src/types/config.ts";

const dir = mkdtempSync(join(tmpdir(), "ppm-voice-svc-"));
let savedProjects: ProjectConfig[];
beforeAll(() => {
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: dir }]);
});
afterAll(() => {
  configService.set("projects", savedProjects);
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => configService.set("voice_message", { review_before_send: true, words: [], projects: {} }));

/** A 16 kHz mono 16-bit WAV of `seconds` of silence. */
function wav(seconds: number): Uint8Array {
  const data = Math.round(seconds * 32_000);
  const buf = new Uint8Array(44 + data);
  const view = new DataView(buf.buffer);
  const put = (at: number, s: string) => [...s].forEach((ch, i) => { buf[at + i] = ch.charCodeAt(0); });
  put(0, "RIFF"); view.setUint32(4, buf.length - 8, true); put(8, "WAVE"); put(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, "data"); view.setUint32(40, data, true);
  return buf;
}

const emptyContext = (input: VoiceContextInput): VoiceContext =>
  ({ recentMessages: [], typed: input.typed ?? "", instructions: "", memory: "", fileNames: [], words: input.words });

function deps(over: Partial<VoiceServiceDeps> = {}) {
  const seen = { transcribe: [] as Array<{ lang: string; prompt: string }>, context: [] as VoiceContextInput[], asks: 0 };
  const d: VoiceServiceDeps = {
    whisperReady: () => true,
    transcribe: async (_wav, lang, prompt) => { seen.transcribe.push({ lang, prompt }); return { text: " sửa rao hồ nô ", ms: 7 }; },
    gatherContext: async (input) => { seen.context.push(input); return emptyContext(input); },
    ask: async () => { seen.asks++; return '{"text":"Sửa route Hono."}'; },
    ...over,
  };
  return { d, seen };
}

const code = async (work: Promise<unknown>) => ((await work.then(() => null, (e) => e)) as VoiceMessageError | null)?.code;

describe("processVoiceMessage", () => {
  it("transcribes with the project's vocabulary, cleans up with the context, and reports both timings", async () => {
    updateVoiceSettings({ words: ["Bun"], project: "demo", projectWords: ["Hono"] });
    const { d, seen } = deps();
    const result = await processVoiceMessage({ audio: wav(2), project: "demo", sessionId: "s", providerId: "claude", typed: "ảnh", lang: "en" }, d);
    expect(result).toMatchObject({ raw: "sửa rao hồ nô", text: "Sửa route Hono.", cleaned: true, transcribeMs: 7 });
    expect(seen.transcribe).toEqual([{ lang: "en", prompt: "Hono, Bun" }]);
    expect(seen.context[0]).toMatchObject({ project: "demo", projectPath: dir, sessionId: "s", providerId: "claude", typed: "ảnh" });
  });

  it("keeps the raw transcript with the reason when the clean-up fails", async () => {
    const { d } = deps({ ask: async () => { throw new Error("No Claude account"); } });
    const result = await processVoiceMessage({ audio: wav(1), project: "demo", lang: "../x" }, d);
    expect(result).toMatchObject({ raw: "sửa rao hồ nô", text: "sửa rao hồ nô", cleaned: false, cleanupError: "No Claude account" });
  });

  it("asks nothing for an empty transcript", async () => {
    const { d, seen } = deps({ transcribe: async () => ({ text: "  ", ms: 3 }) });
    expect(await processVoiceMessage({ audio: wav(1), project: "demo" }, d)).toEqual({ raw: "", text: "", cleaned: false, transcribeMs: 3, cleanupMs: 0 });
    expect(seen.asks).toBe(0);
  });

  it("falls back to Vietnamese for a language that is not a code", async () => {
    const { d, seen } = deps();
    await processVoiceMessage({ audio: wav(1), project: "demo", lang: "../x" }, d);
    expect(seen.transcribe[0]!.lang).toBe("vi");
  });

  it("refuses an unknown project, empty audio, a missing Whisper and an over-long recording", async () => {
    const { d, seen } = deps();
    expect(await code(processVoiceMessage({ audio: wav(1), project: "nope" }, d))).toBe("invalid_project");
    expect(await code(processVoiceMessage({ audio: new Uint8Array(), project: "demo" }, d))).toBe("empty_audio");
    expect(await code(processVoiceMessage({ audio: wav(1), project: "demo" }, { ...d, whisperReady: () => false }))).toBe("whisper_missing");
    expect(await code(processVoiceMessage({ audio: wav(130), project: "demo" }, d))).toBe("too_long");
    expect(seen.transcribe).toEqual([]);
  });

  it("reports a failed run as transcribe_failed", async () => {
    const { d } = deps({ transcribe: async () => { throw new Error("whisper-cli failed: boom"); } });
    expect(await code(processVoiceMessage({ audio: wav(1), project: "demo" }, d))).toBe("transcribe_failed");
  });

  it("accepts the Assistant's virtual project", async () => {
    const { d, seen } = deps();
    await processVoiceMessage({ audio: wav(1), project: "__assistant__" }, d);
    expect(seen.context[0]!.project).toBe("__assistant__");
  });
});

describe("learnFromEdit", () => {
  const before = "anh muốn em mở file cấu hình rồi thêm du tan vào phần quản lý trạng thái của ứng dụng";
  const after = before.replace("du tan", "Zustand");

  it("stores the new corrections in the project's list and returns them", async () => {
    const learned = await learnFromEdit({ project: "demo", before, after }, async () => '{"pairs":[{"from":"du tan","to":"Zustand"}]}');
    expect(learned.map((l) => [l.from, l.word])).toEqual([["du tan", "Zustand"]]);
    expect(readVoiceSettings().projects.demo!.learned.map((l) => l.word)).toEqual(["Zustand"]);
    expect(await learnFromEdit({ project: "demo", before, after }, async () => '{"pairs":[{"from":"du tan","to":"Zustand"}]}')).toEqual([]);
  });

  it("learns nothing when the model fails, and refuses an unknown project", async () => {
    expect(await learnFromEdit({ project: "demo", before, after }, async () => { throw new Error("down"); })).toEqual([]);
    expect(await code(learnFromEdit({ project: "nope", before, after }))).toBe("invalid_project");
  });
});
