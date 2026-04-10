import { resolve } from "node:path";
import { existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";

const isWindows = process.platform === "win32";
const cloudflaredDir = () => resolve(getPpmDir(), "bin");
const cloudflaredPath = () => resolve(cloudflaredDir(), isWindows ? "cloudflared.exe" : "cloudflared");

const OS_MAP: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH_MAP: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/** Build platform-specific GitHub release download URL.
 *  macOS uses .tgz archives, Windows uses .exe, Linux uses raw binaries. */
export function getDownloadUrl(): string {
  const os = OS_MAP[process.platform];
  const arch = ARCH_MAP[process.arch];
  if (!os || !arch) {
    throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  }
  if (os === "windows") {
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`;
  }
  const ext = os === "darwin" ? ".tgz" : "";
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${arch}${ext}`;
}

/** Download file with progress output, returns raw bytes */
async function downloadWithProgress(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const totalBytes = parseInt(res.headers.get("content-length") ?? "0", 10);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.byteLength;
    if (totalBytes > 0) {
      const pct = Math.round((downloaded / totalBytes) * 100);
      process.stdout.write(`\r  Downloading cloudflared... ${pct}%`);
    }
  }
  process.stdout.write("\n");
  return Buffer.concat(chunks);
}

/** Extract cloudflared binary from .tgz archive using tar */
async function extractTgz(tgzPath: string, destDir: string): Promise<void> {
  const proc = Bun.spawn(["tar", "xzf", tgzPath, "-C", destDir, "cloudflared"], {
    stdout: "ignore", stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar extraction failed (exit ${exitCode}): ${stderr}`);
  }
}

/**
 * Ensure cloudflared binary is available at ~/.ppm/bin/cloudflared.
 * Downloads from GitHub releases if missing. Returns path to binary.
 */
export async function ensureCloudflared(): Promise<string> {
  if (existsSync(cloudflaredPath())) return cloudflaredPath();

  if (!existsSync(cloudflaredDir())) {
    mkdirSync(cloudflaredDir(), { recursive: true });
  }

  const url = getDownloadUrl();
  const isTgz = url.endsWith(".tgz");
  const isExe = url.endsWith(".exe");
  const tmpPath = resolve(cloudflaredDir(), isTgz ? "cloudflared.tgz" : isExe ? "cloudflared.exe.tmp" : "cloudflared.tmp");

  try {
    const data = await downloadWithProgress(url);
    await Bun.write(tmpPath, data);

    if (isTgz) {
      await extractTgz(tmpPath, cloudflaredDir());
      unlinkSync(tmpPath);
    } else {
      renameSync(tmpPath, cloudflaredPath());
    }
    if (!isWindows) {
      chmodSync(cloudflaredPath(), 0o755);
    }
  } catch (err) {
    try { unlinkSync(tmpPath); } catch {}
    try { unlinkSync(cloudflaredPath()); } catch {}
    throw err;
  }

  return cloudflaredPath();
}

/** Get path where cloudflared binary is/will be stored */
export function getCloudflaredPath(): string {
  return cloudflaredPath();
}
