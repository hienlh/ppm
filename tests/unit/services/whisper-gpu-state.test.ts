import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { _setNvidiaDetector, type NvidiaGpu } from "../../../src/services/speech-to-text/whisper-gpu-detect.ts";
import {
  forgetProbe,
  gpuPreference,
  installedBuild,
  probeFor,
  recordGpuFailure,
  setGpuPreference,
  silentWav,
  whisperGpuStatus,
} from "../../../src/services/speech-to-text/whisper-gpu-state.ts";
import { whisperBinDir, whisperDir } from "../../../src/services/speech-to-text/whisper-paths.ts";

let home: string;
const prevHome = process.env.PPM_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-whisper-gpu-"));
  process.env.PPM_HOME = home;
  _resetPpmDir();
  _setNvidiaDetector(async () => null);
});

afterEach(() => {
  _setNvidiaDetector(null);
  rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = prevHome;
  _resetPpmDir();
});

const RTX: NvidiaGpu = { name: "NVIDIA GeForce RTX 4070", driver: "610.88", cuda: "13.3", supportsCudaBuild: true };

/** A bundled whisper-cli on disk, laid out as the release archive unpacks. */
function fakeBundledBuild(kind: "cpu" | "cuda"): string {
  const dir = resolve(whisperBinDir(), "Release");
  mkdirSync(dir, { recursive: true });
  const cli = resolve(dir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  writeFileSync(cli, "");
  if (kind === "cuda") writeFileSync(resolve(dir, "ggml-cuda.dll"), "");
  return cli;
}

describe("the Use GPU switch", () => {
  it("is on until the user turns it off, and stays off", () => {
    expect(gpuPreference()).toBe(true);
    setGpuPreference(false);
    expect(gpuPreference()).toBe(false);
    expect(JSON.parse(readFileSync(resolve(whisperDir(), "gpu.json"), "utf8")).useGpu).toBe(false);
  });

  it("survives a corrupt state file by going back to the default", () => {
    mkdirSync(whisperDir(), { recursive: true });
    writeFileSync(resolve(whisperDir(), "gpu.json"), "{not json");
    expect(gpuPreference()).toBe(true);
  });
});

describe("installedBuild", () => {
  it("tells the CUDA archive from the CPU one by its CUDA backend", () => {
    expect(installedBuild(null)).toBeNull();
    expect(installedBuild({ path: "/opt/homebrew/bin/whisper-cli", source: "system" })).toBe("system");
    const cpu = fakeBundledBuild("cpu");
    expect(installedBuild({ path: cpu, source: "bundled" })).toBe("cpu");
    const cuda = fakeBundledBuild("cuda");
    expect(installedBuild({ path: cuda, source: "bundled" })).toBe("cuda");
  });
});

describe("silentWav", () => {
  it("is a valid 16 kHz mono 16-bit WAV of the asked length", () => {
    const wav = Buffer.from(silentWav(1));
    expect(wav.length).toBe(44 + 32_000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(40)).toBe(32_000);
  });
});

describe("whisperGpuStatus", () => {
  it("offers the CUDA build only where it is published and the card can load it", async () => {
    _setNvidiaDetector(async () => RTX);
    const win = await whisperGpuStatus({ platform: "win32", arch: "x64" });
    expect(win.nvidia?.name).toBe(RTX.name);
    expect(win.cudaBuild?.bytes).toBe(674_539_285);

    _setNvidiaDetector(async () => ({ ...RTX, supportsCudaBuild: false }));
    expect((await whisperGpuStatus({ platform: "win32", arch: "x64" })).cudaBuild).toBeNull();
  });

  it("does not ask the driver on a platform with no CUDA build", async () => {
    let asked = 0;
    _setNvidiaDetector(async () => { asked++; return RTX; });
    const linux = await whisperGpuStatus({ platform: "linux", arch: "x64" });
    const mac = await whisperGpuStatus({ platform: "darwin", arch: "arm64" });
    expect(asked).toBe(0);
    expect(linux.cudaBuild).toBeNull();
    expect(mac.nvidia).toBeNull();
  });

  it("records PPM's CPU build as CPU-only without running it", async () => {
    const cli = fakeBundledBuild("cpu");
    const status = await whisperGpuStatus({ platform: process.platform, arch: process.arch, modelPath: "/nowhere/model.bin" });
    expect(status.installedBuild).toBe("cpu");
    expect(status.backend).toBe("none");
    expect(status.probing).toBe(false);
    expect(probeFor({ path: cli, source: "bundled" })?.backend).toBe("none");
    // The same path with the other build behind it is a different binary: its probe is not reused.
    writeFileSync(resolve(cli, "..", "ggml-cuda.dll"), "");
    expect(probeFor({ path: cli, source: "bundled" })).toBeNull();
  });

  it("reports the last GPU failure until the probe is forgotten", async () => {
    recordGpuFailure("CUDA error: out of memory");
    expect((await whisperGpuStatus()).lastFailure?.message).toBe("CUDA error: out of memory");
    forgetProbe();
    expect((await whisperGpuStatus()).lastFailure).toBeNull();
    expect(existsSync(resolve(whisperDir(), "gpu.json"))).toBe(true);
  });
});
