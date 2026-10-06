import { join } from "node:path";
import { findFfmpegBinary } from "../media-transcode/ffmpeg-capabilities.ts";

export interface FfmpegInstallStatus {
  state: "idle" | "installing" | "installed" | "error";
  error?: string;
}

// Fixed package and flags: no client-supplied command is executed.
export const FFMPEG_INSTALL_ARGS = [
  "install", "--id", "Gyan.FFmpeg", "-e", "--source", "winget", "--silent",
  "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
];

async function outputTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      tail = (tail + decoder.decode(value, { stream: true })).slice(-4096);
    }
    return (tail + decoder.decode()).slice(-4096);
  } finally { reader.releaseLock(); }
}

async function installWithWinget(): Promise<void> {
  const local = process.env.LOCALAPPDATA;
  const winget = Bun.which("winget") ?? (local
    ? Bun.which("winget", { PATH: join(local, "Microsoft", "WindowsApps") }) : null);
  // App Installer exposes an execution alias that Bun.which/existsSync cannot see.
  // cmd resolves it through Windows; every argument here is fixed, never user input.
  const command = winget ? [winget, ...FFMPEG_INSTALL_ARGS]
    : [join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), "/d", "/c", "winget", ...FFMPEG_INSTALL_ARGS];
  const proc = Bun.spawn(command, {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 10 * 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, outputTail(proc.stdout), outputTail(proc.stderr),
    ]);
    if (timedOut) throw new Error("FFmpeg installation timed out after 10 minutes. Check WinGet on the Windows host, then retry.");
    if (code !== 0) throw new Error(`WinGet failed (${code}): ${(stderr || stdout).trim().slice(-2000) || "Check App Installer on the Windows host."}`);
  } finally { clearTimeout(timer); }
}

/** One host-wide job. HTTP requests return immediately and poll its status. */
export class FfmpegInstaller {
  private status: FfmpegInstallStatus = { state: "idle" };
  constructor(private readonly deps = {
    platform: () => process.platform as string,
    find: () => findFfmpegBinary("ffmpeg"),
    install: installWithWinget,
  }) {}

  getStatus(): FfmpegInstallStatus { return { ...this.status }; }

  start(): FfmpegInstallStatus {
    if (this.deps.platform() !== "win32") throw new Error("Automatic FFmpeg installation is only supported on Windows.");
    if (this.status.state === "installing") return this.getStatus();
    if (this.deps.find()) {
      this.status = { state: "installed" };
      return this.getStatus();
    }
    this.status = { state: "installing" };
    void this.run();
    return this.getStatus();
  }

  private async run(): Promise<void> {
    try {
      await this.deps.install();
      if (!this.deps.find()) throw new Error("WinGet completed but FFmpeg could not be found. Check the installation on the Windows host, then retry.");
      this.status = { state: "installed" };
    } catch (error) {
      this.status = { state: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

export const ffmpegInstaller = new FfmpegInstaller();
