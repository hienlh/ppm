import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { createSpeechRoutes } from "../../../src/server/routes/speech.ts";
import type { VoiceRouteDeps } from "../../../src/server/routes/speech-voice-message.ts";
import { VoiceMessageError } from "../../../src/services/voice-message/voice-message-errors.ts";
import type { ProcessVoiceInput, ProcessVoiceResult } from "../../../src/services/voice-message/voice-message.service.ts";
import { FEATURE_INTROS_CHANGED_EVENT } from "../../../src/shared/feature-intros.ts";
import type { ProjectConfig } from "../../../src/types/config.ts";

const dir = mkdtempSync(join(tmpdir(), "ppm-voice-routes-"));
let savedProjects: ProjectConfig[];
beforeAll(() => {
  savedProjects = configService.get("projects");
  configService.set("projects", [{ name: "demo", path: dir }]);
});
afterAll(() => {
  configService.set("projects", savedProjects);
  configService.set("feature_intros", {});
  configService.set("voice_message", { review_before_send: true, words: [], projects: {} });
  rmSync(dir, { recursive: true, force: true });
});

let events: unknown[];
let ready: boolean;
let processed: ProcessVoiceInput[];
let processResult: () => Promise<ProcessVoiceResult>;
const CLEANED: ProcessVoiceResult = { raw: "sửa hồ nô", text: "Sửa Hono.", cleaned: true, transcribeMs: 5, cleanupMs: 6 };

const deps: VoiceRouteDeps = {
  broadcast: (e) => events.push(e),
  process: async (input) => { processed.push(input); return processResult(); },
  learn: async ({ after }) => [{ word: after, from: "x", at: "2026-11-20T00:00:00.000Z" }],
  whisperReady: () => ready,
};
const app = () => new Hono().route("/speech", createSpeechRoutes(deps));
const json = async (res: Response) => (await res.json()) as { ok: boolean; data?: any; error?: string; code?: string };
const put = (body: unknown) => app().request("/speech/voice-settings", {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const postVoice = (fields: Record<string, string | Blob>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return app().request("/speech/voice-message", { method: "POST", body: form });
};
const learn = (body: unknown) => app().request("/speech/voice-learn", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const audio = () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" });

beforeEach(() => {
  events = [];
  ready = true;
  processed = [];
  processResult = async () => CLEANED;
  configService.set("voice_message", { review_before_send: true, words: [], projects: {} });
  configService.set("feature_intros", {});
});

describe("/voice-settings", () => {
  it("answers the defaults, the project's lists and whether Whisper is ready", async () => {
    ready = false;
    const res = await app().request("/speech/voice-settings?project=demo");
    expect((await json(res)).data).toEqual({
      enabled: false, reviewBeforeSend: true, words: [], projectWords: [], projectLearned: [], whisperReady: false,
    });
  });

  it("saves lists and the review switch", async () => {
    const res = await put({ reviewBeforeSend: false, words: ["Bun", "bun"], project: "demo", projectWords: ["Hono"] });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ reviewBeforeSend: false, words: ["Bun"], projectWords: ["Hono"] });
    expect(events).toEqual([]);
  });

  it("counts the master switch as the feature intro's answer and announces it", async () => {
    expect((await json(await put({ enabled: true }))).data.enabled).toBe(true);
    expect(events).toEqual([{ type: FEATURE_INTROS_CHANGED_EVENT, change: "settings" }]);
    const intro = (configService.get("feature_intros") as Record<string, { answer?: string; via?: string }>)["voice-messages-2026-11"];
    expect(intro).toMatchObject({ answer: "on", via: "settings" });
  });

  it("refuses bad shapes, an unknown project and project lists without a project", async () => {
    for (const body of [[], { enabled: "yes" }, { words: "Hono" }, { words: [1] }, { project: "nope", projectWords: [] }, { projectWords: ["x"] }]) {
      expect((await put(body)).status).toBe(400);
    }
  });
});

describe("/voice-message", () => {
  it("is refused while the feature is off", async () => {
    const res = await postVoice({ audio: audio(), project: "demo" });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("voice_messages_off");
  });

  it("answers 409 whisper_missing without processing anything", async () => {
    await put({ enabled: true });
    ready = false;
    const res = await postVoice({ audio: audio(), project: "demo" });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe("whisper_missing");
    expect(processed).toEqual([]);
  });

  it("refuses a missing file or project", async () => {
    await put({ enabled: true });
    expect((await postVoice({ project: "demo" })).status).toBe(400);
    expect((await postVoice({ audio: audio() })).status).toBe(400);
  });

  it("passes the fields on and answers with the review setting", async () => {
    await put({ enabled: true, reviewBeforeSend: false });
    const res = await postVoice({ audio: audio(), project: "demo", sessionId: "s1", providerId: "codex", typed: "ảnh", lang: "en" });
    const data = (await json(res)).data;
    expect(data).toMatchObject({ ...CLEANED, reviewBeforeSend: false });
    // The step timings the composer shows: reading the upload, then the whole handler.
    expect(data.receiveMs).toBeGreaterThanOrEqual(0);
    expect(data.serverMs).toBeGreaterThanOrEqual(data.receiveMs);
    expect(processed[0]).toMatchObject({ project: "demo", sessionId: "s1", providerId: "codex", typed: "ảnh", lang: "en" });
    expect(processed[0]!.audio).toBeInstanceOf(Uint8Array);
  });

  it("answers the plain setting and the clean-up's failure apart, so the client can hold on cleaned:false", async () => {
    await put({ enabled: true, reviewBeforeSend: false });
    processResult = async () => ({ ...CLEANED, text: CLEANED.raw, cleaned: false, cleanupError: "no account" });
    const data = (await json(await postVoice({ audio: audio(), project: "demo" }))).data;
    expect(data).toMatchObject({ cleaned: false, cleanupError: "no account", reviewBeforeSend: false });
  });

  it("maps service errors to statuses and codes", async () => {
    await put({ enabled: true });
    processResult = async () => { throw new VoiceMessageError("ffmpeg_missing", "Reading this audio needs ffmpeg on the PPM host"); };
    const res = await postVoice({ audio: audio(), project: "demo" });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ ok: false, code: "ffmpeg_missing" });
  });
});

describe("/voice-learn", () => {
  it("is refused while the feature is off, then learns for a known project", async () => {
    expect((await learn({ project: "demo", before: "a", after: "b" })).status).toBe(409);
    await put({ enabled: true });
    expect((await json(await learn({ project: "demo", before: "a", after: "Hono" }))).data.learned[0].word).toBe("Hono");
    expect((await learn({ project: "nope", before: "a", after: "b" })).status).toBe(400);
    expect((await learn({ project: "demo", before: 1, after: "b" })).status).toBe(400);
  });
});
