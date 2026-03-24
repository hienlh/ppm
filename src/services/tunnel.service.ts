import type { Subprocess } from "bun";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { ensureCloudflared } from "./cloudflared.service.ts";

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const decoder = new TextDecoder();
const RESTARTING_FLAG = resolve(homedir(), ".ppm", ".restarting");

/** Extract tunnel URL from cloudflared stderr output */
export function extractTunnelUrl(text: string): string | null {
  const match = text.match(TUNNEL_URL_REGEX);
  return match ? match[0] : null;
}

class TunnelService {
  private childProcess: Subprocess | null = null;
  private externalPid: number | null = null;
  private url: string | null = null;
  private cleanupHandler: (() => void) | null = null;

  /** Spawn cloudflared Quick Tunnel and return public URL */
  async startTunnel(port: number): Promise<string> {
    const bin = await ensureCloudflared();

    const proc = Bun.spawn(
      [bin, "tunnel", "--url", `http://127.0.0.1:${port}`],
      { stderr: "pipe", stdout: "ignore", stdin: "ignore" },
    );
    this.childProcess = proc;

    // Register cleanup handlers (remove old ones first to prevent leak)
    if (this.cleanupHandler) {
      process.off("SIGINT", this.cleanupHandler);
      process.off("SIGTERM", this.cleanupHandler);
      process.off("exit", this.cleanupHandler);
    }
    this.cleanupHandler = () => this.stopTunnel();
    process.on("SIGINT", this.cleanupHandler);
    process.on("SIGTERM", this.cleanupHandler);
    // Windows: SIGINT/SIGTERM may not fire on Ctrl+C — use 'exit' as fallback
    process.on("exit", this.cleanupHandler);

    // Read stderr to find tunnel URL, then keep draining to avoid SIGPIPE
    const reader = proc.stderr.getReader();
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Tunnel timed out after 30s — no URL found"));
      }, 30_000);

      let buffer = "";
      let found = false;
      const read = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (found) continue; // Keep draining but don't accumulate
            buffer += decoder.decode(value, { stream: true });
            const match = extractTunnelUrl(buffer);
            if (match) {
              found = true;
              buffer = ""; // Free memory
              clearTimeout(timeout);
              resolve(match);
            }
          }
          if (!found) {
            clearTimeout(timeout);
            reject(new Error("cloudflared exited without providing tunnel URL"));
          }
        } catch (err) {
          if (!found) {
            clearTimeout(timeout);
            reject(err);
          }
        }
      };
      read();
    });

    this.url = url;
    this.persistToStatusFile();
    this.syncToCloud();
    return url;
  }

  /** Kill the cloudflared child process (skipped during restart) */
  stopTunnel(): void {
    if (this.cleanupHandler) {
      process.off("SIGINT", this.cleanupHandler);
      process.off("SIGTERM", this.cleanupHandler);
      process.off("exit", this.cleanupHandler);
      this.cleanupHandler = null;
    }
    // If server is restarting, keep tunnel alive
    if (existsSync(RESTARTING_FLAG)) {
      this.childProcess = null;
      this.externalPid = null;
      this.url = null;
      return;
    }
    if (this.childProcess) {
      try { this.childProcess.kill(); } catch {}
      this.childProcess = null;
    }
    if (this.externalPid) {
      try { process.kill(this.externalPid); } catch {}
      this.externalPid = null;
    }
    this.url = null;
    this.persistToStatusFile();
    this.stopCloudSync();
  }

  /** Get current tunnel URL (null if not running) */
  getTunnelUrl(): string | null {
    return this.url;
  }

  /** Get cloudflared PID (child process or external) */
  getTunnelPid(): number | null {
    return this.childProcess?.pid ?? this.externalPid;
  }

  /** Inject an externally-started tunnel URL (e.g. from daemon --share) */
  setExternalUrl(url: string): void {
    this.url = url;
    this.persistToStatusFile();
    this.syncToCloud();
  }

  /** Adopt an externally-started tunnel by PID (for stop management after restart) */
  setExternalPid(pid: number): void {
    this.externalPid = pid;
  }

  /** Persist shareUrl + tunnelPid to status.json (central write point) */
  private persistToStatusFile(): void {
    const statusFile = resolve(homedir(), ".ppm", "status.json");
    if (!existsSync(statusFile)) return;
    try {
      const data = JSON.parse(readFileSync(statusFile, "utf-8"));
      data.shareUrl = this.url;
      data.tunnelPid = this.getTunnelPid() ?? null;
      writeFileSync(statusFile, JSON.stringify(data));
    } catch {}
  }

  /** Start cloud heartbeat if device is linked (non-blocking) */
  private syncToCloud(): void {
    if (!this.url) return;
    const url = this.url;
    import("./cloud.service.ts")
      .then(({ startHeartbeat, getCloudDevice }) => {
        if (getCloudDevice()) startHeartbeat(url);
      })
      .catch(() => {});
  }

  /** Stop cloud heartbeat (non-blocking) */
  private stopCloudSync(): void {
    import("./cloud.service.ts")
      .then(({ stopHeartbeat }) => stopHeartbeat())
      .catch(() => {});
  }
}

/** Singleton tunnel service */
export const tunnelService = new TunnelService();
