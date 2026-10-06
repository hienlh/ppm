import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FfmpegInstaller } from "../../../../src/services/remote-desktop/ffmpeg-install.ts";
import { wingetFfmpegBinDirs } from "../../../../src/services/media-transcode/ffmpeg-capabilities.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FFmpeg installation", () => {
  it("shares one background job, verifies discovery, and skips an existing install", async () => {
    let complete!: () => void;
    let found: string | null = null;
    let runs = 0;
    const installer = new FfmpegInstaller({ platform: () => "win32", find: () => found,
      install: () => { runs++; return new Promise<void>((resolve) => { complete = resolve; }); } });
    expect(installer.getStatus()).toEqual({ state: "idle" });
    expect(installer.start()).toEqual({ state: "installing" });
    expect(installer.start()).toEqual({ state: "installing" });
    expect(runs).toBe(1);
    found = "C:\\ffmpeg\\bin\\ffmpeg.exe";
    complete();
    await flush();
    expect(installer.getStatus()).toEqual({ state: "installed" });
    expect(installer.start()).toEqual({ state: "installed" });
    expect(runs).toBe(1);
  });

  it("reports failures and allows retry; exit zero without a discoverable binary is an error", async () => {
    let fail = true;
    const installer = new FfmpegInstaller({ platform: () => "win32", find: () => null,
      install: async () => { if (fail) throw new Error("winget failed"); } });
    installer.start();
    await flush();
    expect(installer.getStatus()).toEqual({ state: "error", error: "winget failed" });
    fail = false;
    expect(installer.start().state).toBe("installing");
    await flush();
    expect(installer.getStatus().state).toBe("error");
    expect(installer.getStatus().error).toContain("could not be found");
  });

  it("does not execute installers on other platforms", () => {
    let runs = 0;
    const installer = new FfmpegInstaller({ platform: () => "linux", find: () => null,
      install: async () => { runs++; } });
    expect(() => installer.start()).toThrow("only supported on Windows");
    expect(runs).toBe(0);
  });

  it("finds the archive bin path that WinGet adds only to future process PATHs", () => {
    const local = mkdtempSync(join(tmpdir(), "ppm-winget-"));
    const bin = join(local, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-8.0-full_build", "bin");
    try {
      mkdirSync(bin, { recursive: true });
      expect(wingetFfmpegBinDirs(local)).toContain(bin);
    } finally { rmSync(local, { recursive: true, force: true }); }
  });
});
