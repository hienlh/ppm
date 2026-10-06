import { resolve } from "node:path";
import { existsSync, mkdirSync, chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getPpmDir } from "./ppm-dir.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("cloudflared");

const isWindows = process.platform === "win32";
const cloudflaredDir = () => resolve(getPpmDir(), "bin");
const cloudflaredPath = () => resolve(cloudflaredDir(), isWindows ? "cloudflared.exe" : "cloudflared");
const quickTunnelConfigPath = () => resolve(getPpmDir(), "cloudflared-quick.yml");

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
  // A progress bar is for a terminal. Under the supervisor or the server stdout is ppm.log or
  // the journal, where the `\r` frames run together into one long line.
  const tty = !!process.stdout.isTTY;
  let loggedTenths = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.byteLength;
    if (totalBytes > 0) {
      const pct = Math.round((downloaded / totalBytes) * 100);
      if (tty) {
        process.stdout.write(`\r  Downloading cloudflared... ${pct}%`);
      } else if (Math.floor(pct / 10) > loggedTenths) {
        loggedTenths = Math.floor(pct / 10);
        log.debug(`Downloading cloudflared... ${pct}%`);
      }
    }
  }
  if (tty) process.stdout.write("\n");
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

  log.info(`cloudflared missing — downloading ${url}`);
  const startedAt = Date.now();
  let bytes = 0;
  try {
    const data = await downloadWithProgress(url);
    bytes = data.byteLength;
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

  log.info(`cloudflared installed at ${cloudflaredPath()} (${(bytes / 1048576).toFixed(1)} MB, ${Date.now() - startedAt}ms)`);
  return cloudflaredPath();
}

/** Get path where cloudflared binary is/will be stored */
export function getCloudflaredPath(): string {
  return cloudflaredPath();
}

/**
 * Argv (minus the binary) for a quick tunnel to a local port.
 *
 * The `--config` pin is load-bearing: cloudflared auto-loads
 * `~/.cloudflared/config.yml` even for `tunnel --url`. If the user also runs a
 * named tunnel, that file's ingress rules apply to PPM's quick tunnel too, and
 * its catch-all (`service: http_status:404`) answers every request before it
 * reaches the origin — the tunnel registers fine but serves only 404s, so the
 * health probe regenerates it forever. Pointing at our own empty config
 * isolates PPM from whatever the user has configured.
 */
export function getQuickTunnelArgs(port: number): string[] {
  return getQuickTunnelArgsTo(`http://127.0.0.1:${port}`);
}

/** The same quick-tunnel argv aimed at any origin URL (a port forward points it at its hop). */
export function getQuickTunnelArgsTo(originUrl: string): string[] {
  return ["--config", ensureQuickTunnelConfig(), "tunnel", "--url", originUrl];
}

/** Create the empty quick-tunnel config if absent; returns its path. */
function ensureQuickTunnelConfig(): string {
  const path = quickTunnelConfigPath();
  if (!existsSync(path)) {
    mkdirSync(getPpmDir(), { recursive: true });
    writeFileSync(path, "# PPM quick tunnel config — intentionally empty. Do not add ingress rules.\n");
  }
  return path;
}
