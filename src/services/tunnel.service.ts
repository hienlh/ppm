import type { Subprocess } from "bun";
import { ensureCloudflared } from "./cloudflared.service.ts";

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const decoder = new TextDecoder();

/** Extract tunnel URL from cloudflared stderr output */
export function extractTunnelUrl(text: string): string | null {
  const match = text.match(TUNNEL_URL_REGEX);
  return match ? match[0] : null;
}

class TunnelService {
  private childProcess: Subprocess | null = null;
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
    return url;
  }

  /** Kill the cloudflared child process */
  stopTunnel(): void {
    if (this.cleanupHandler) {
      process.off("SIGINT", this.cleanupHandler);
      process.off("SIGTERM", this.cleanupHandler);
      process.off("exit", this.cleanupHandler);
      this.cleanupHandler = null;
    }
    if (this.childProcess) {
      try { this.childProcess.kill(); } catch {}
      this.childProcess = null;
    }
    this.url = null;
  }

  /** Get current tunnel URL (null if not running) */
  getTunnelUrl(): string | null {
    return this.url;
  }
}

/** Singleton tunnel service */
export const tunnelService = new TunnelService();
