import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { _resetWhisperInstallState } from "../../../src/services/speech-to-text/whisper-install.service.ts";
import { speechRoutes } from "../../../src/server/routes/speech.ts";

let home: string;
const prevHome = process.env.PPM_HOME;
const app = () => new Hono().route("/speech", speechRoutes);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-speech-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
  _resetWhisperInstallState();
});

afterEach(() => {
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
