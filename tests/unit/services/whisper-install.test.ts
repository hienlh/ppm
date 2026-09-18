import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import {
  MACOS_INSTALL_HINT,
  VAD_MODEL,
  WHISPER_BUILD,
  WHISPER_MODELS,
  modelById,
  modelUrl,
  vadModelUrl,
  whisperAssetFor,
} from "../../../src/services/speech-to-text/whisper-catalog.ts";
import { downloadVerified } from "../../../src/services/speech-to-text/whisper-download.ts";
import { findBundledBinary, whisperBinDir } from "../../../src/services/speech-to-text/whisper-paths.ts";
import {
  _resetWhisperInstallState,
  getWhisperStatus,
  startWhisperInstall,
} from "../../../src/services/speech-to-text/whisper-install.service.ts";

let home: string;
const prevHome = process.env.PPM_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ppm-whisper-"));
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

describe("whisper catalog", () => {
  it("has a build for the platforms whisper.cpp publishes one for", () => {
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
      ["win32", "arm64"],
    ] as const) {
      const asset = whisperAssetFor(platform, arch);
      expect(asset, `${platform}/${arch}`).not.toBeNull();
      expect(asset!.url).toContain(`/${WHISPER_BUILD}/`);
      expect(asset!.url).toEndWith(asset!.file);
      expect(asset!.ext).toBe(platform === "win32" ? "zip" : "tar.gz");
    }
  });

  it("has none for macOS, which installs through Homebrew instead", () => {
    expect(whisperAssetFor("darwin", "arm64")).toBeNull();
    expect(whisperAssetFor("darwin", "x64")).toBeNull();
    expect(MACOS_INSTALL_HINT).toContain("brew install");
  });

  it("pins every download by sha256 and revision", () => {
    const hex = /^[0-9a-f]{64}$/;
    for (const [platform, arch] of [["linux", "x64"], ["win32", "x64"]] as const) {
      expect(whisperAssetFor(platform, arch)!.sha256).toMatch(hex);
    }
    for (const model of WHISPER_MODELS) {
      expect(model.sha256, model.id).toMatch(hex);
      expect(model.bytes).toBeGreaterThan(0);
      // A moving `main` would let the bytes behind a pinned hash change under us.
      expect(modelUrl(model)).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(modelUrl(model)).toEndWith(model.file);
    }
    expect(VAD_MODEL.sha256).toMatch(hex);
    expect(vadModelUrl()).toMatch(/\/resolve\/[0-9a-f]{40}\//);
  });
});

describe("downloadVerified", () => {
  async function serve(body: Uint8Array | string) {
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    return { url: `http://127.0.0.1:${server.port}/file`, stop: () => server.stop(true) };
  }

  it("writes the file and reports progress when the hash matches", async () => {
    const body = "whisper bytes";
    const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const { url, stop } = await serve(body);
    const dest = join(home, "ok.bin");
    const seen: number[] = [];

    try {
      await downloadVerified({ url, dest, sha256: sha, onProgress: (received) => seen.push(received) });
    } finally {
      stop();
    }

    expect(await Bun.file(dest).text()).toBe(body);
    expect(seen.at(-1)).toBe(body.length);
  });

  it("throws and leaves nothing behind when the hash does not match", async () => {
    const { url, stop } = await serve("tampered");
    const dest = join(home, "bad.bin");

    try {
      await expect(
        downloadVerified({ url, dest, sha256: "0".repeat(64) }),
      ).rejects.toThrow(/checksum mismatch/);
    } finally {
      stop();
    }

    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("throws on a failed request", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 404 }) });
    const url = `http://127.0.0.1:${server.port}/missing`;
    try {
      await expect(downloadVerified({ url, dest: join(home, "x.bin"), sha256: "0".repeat(64) })).rejects.toThrow(
        /HTTP 404/,
      );
    } finally {
      server.stop(true);
    }
  });
});

describe("findBundledBinary", () => {
  it("finds the cli inside the archive's own directory", () => {
    // The Linux archive unpacks as whisper-bin-ubuntu-x64/, Windows as Release/.
    const dir = resolve(whisperBinDir(), "whisper-bin-ubuntu-x64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "whisper-cli"), "");

    expect(findBundledBinary("linux")).toBe(resolve(dir, "whisper-cli"));
  });

  it("is null when nothing is installed", () => {
    expect(findBundledBinary("linux")).toBeNull();
  });
});

describe("getWhisperStatus", () => {
  it("reports not-ready with no model on disk", () => {
    const status = getWhisperStatus("linux", "x64");
    expect(status.model).toBeNull();
    expect(status.ready).toBe(false);
    expect(status.install).toBeNull();
    expect(status.models.map((m) => m.id)).toEqual(WHISPER_MODELS.map((m) => m.id));
  });

  it("names the model on disk once its file is there", () => {
    const model = modelById("base-q5_1")!;
    mkdirSync(resolve(home, "whisper", "models"), { recursive: true });
    writeFileSync(resolve(home, "whisper", "models", model.file), "");

    expect(getWhisperStatus("linux", "x64").model?.id).toBe("base-q5_1");
  });
});

describe("startWhisperInstall", () => {
  it("refuses a model it does not know, without starting anything", () => {
    expect(() => startWhisperInstall("gpt-4-audio")).toThrow(/unknown model/);
    expect(getWhisperStatus("linux", "x64").install).toBeNull();
  });
});
