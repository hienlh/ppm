import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { _resetWhisperInstallState } from "../../../src/services/speech-to-text/whisper-install.service.ts";
import { speechRoutes } from "../../../src/server/routes/speech.ts";
import { _setNvidiaDetector } from "../../../src/services/speech-to-text/whisper-gpu-detect.ts";

let home: string;
const prevHome = process.env.PPM_HOME;
const app = () => new Hono().route("/speech", speechRoutes);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-speech-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
  _resetWhisperInstallState();
  _setNvidiaDetector(async () => null);
});

afterEach(() => {
  _setNvidiaDetector(null);
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = prevHome;
  _resetPpmDir();
});

const post = (path: string, init?: RequestInit) => app().request(path, { method: "POST", ...init });

describe("GET /speech/status", () => {
  it("answers the model catalogue with nothing installed", async () => {
    const res = await app().request("/speech/status");
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.data.ready).toBe(false);
    expect(json.data.model).toBeNull();
    expect(json.data.models.length).toBeGreaterThan(0);
  });
});

describe("POST /speech/transcribe", () => {
  it("rejects an empty body", async () => {
    const res = await post("/speech/transcribe", { body: new Uint8Array() });
    expect(res.status).toBe(400);
  });

  it("rejects a language that is not a language code", async () => {
    const res = await post("/speech/transcribe?lang=../../etc", { body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(400);
  });

  it("answers 409 rather than spawning anything when Whisper is not installed", async () => {
    const res = await post("/speech/transcribe", { body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("not installed");
  });

  it("refuses audio over the size cap", async () => {
    const res = await post("/speech/transcribe", { body: new Uint8Array(26 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe("POST /speech/install", () => {
  it("answers 409 for a model that is not in the catalogue", async () => {
    const res = await post("/speech/install", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "not-a-model" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("POST /speech/uninstall", () => {
  it("is safe to call when nothing is installed", async () => {
    const res = await post("/speech/uninstall");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.ready).toBe(false);
  });
});

describe("Whisper's GPU", () => {
  const json = (body: unknown): RequestInit => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("includes the GPU half in the status", async () => {
    const res = await app().request("/speech/status");
    const data = ((await res.json()) as any).data;
    expect(data.gpu.useGpu).toBe(true);
    expect(data.gpu.installedBuild).toBeNull();
    expect(data.gpu.backend).toBeNull();
  });

  it("refuses a build that is neither cpu nor cuda", async () => {
    const res = await post("/speech/install", json({ model: "base-q5_1", build: "metal" }));
    expect(res.status).toBe(400);
  });

  it("refuses the CUDA build on a host without a card that can load it", async () => {
    _setNvidiaDetector(async () => null);
    const res = await post("/speech/install", json({ model: "base-q5_1", build: "cuda" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("NVIDIA");
  });

  it("stores the Use GPU switch and answers the new status", async () => {
    expect((await post("/speech/gpu", json({ useGpu: "no" }))).status).toBe(400);
    const res = await post("/speech/gpu", json({ useGpu: false }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.gpu.useGpu).toBe(false);
  });

  it("answers 409 to a GPU check with nothing installed", async () => {
    expect((await post("/speech/gpu/check")).status).toBe(409);
  });
});

describe("Whisper's GPU, with the CUDA build already installed", () => {
  it("does not ask for a card that answers to switch models on the build already in place", async () => {
    _setNvidiaDetector(async () => null);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(home, "whisper", "bin", "Release");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"), "");
    writeFileSync(join(dir, "ggml-cuda.dll"), "");
    const res = await post("/speech/install", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "not-a-model", build: "cuda" }) });
    // Past the GPU gate: what refuses it now is the unknown model, not the missing card.
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain("unknown model");
  });
});

describe("POST /speech/test", () => {
  it("checks the request before touching whisper-cli", async () => {
    expect((await post("/speech/test", { body: new Uint8Array() })).status).toBe(400);
    expect((await post("/speech/test?device=gpu", { body: new Uint8Array([1]) })).status).toBe(400);
    expect((await post("/speech/test?lang=../x", { body: new Uint8Array([1]) })).status).toBe(400);
    // A test is a few seconds: a long upload is refused rather than transcribed.
    expect((await post("/speech/test", { body: new Uint8Array(2_000_000) })).status).toBe(413);
  });

  it("answers 409 rather than spawning anything when Whisper is not installed", async () => {
    const res = await post("/speech/test?device=cpu", { body: new Uint8Array([1, 2, 3]) });
    expect(res.status).toBe(409);
  });
});
