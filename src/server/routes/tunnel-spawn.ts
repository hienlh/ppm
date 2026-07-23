/**
 * Shared cloudflared quick-tunnel spawn logic + the active-tunnel registry map.
 *
 * Extracted from port-forwarding.ts so both the legacy `/api/preview/*` routes
 * and the new `/api/tunnels` registry routes reuse ONE spawn implementation and
 * ONE shared `activeTunnels` map (no duplicate spawn logic, no split-brain state).
 */
import { ensureCloudflared } from "../../services/cloudflared.service.ts";

export const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface ActiveTunnel {
  port: number;
  url: string;
  process: import("bun").Subprocess;
  /** OS PID of the cloudflared process — required for registry merge/kill by PID. */
  pid: number;
  startedAt: number;
  probeFailures: number;
}

export const MAX_PROBE_FAILURES = 2;

/** Active PPM-spawned tunnels keyed by port — exported for testing + registry. */
export const activeTunnels = new Map<number, ActiveTunnel>();

/** Spawn cloudflared quick tunnel for a port, extract URL from stderr. */
export async function spawnTunnelProcess(
  port: number,
): Promise<{ process: import("bun").Subprocess; url: string }> {
  const bin = await ensureCloudflared();
  const proc = Bun.spawn(
    [bin, "tunnel", "--url", `http://127.0.0.1:${port}`],
    { stderr: "pipe", stdout: "ignore", stdin: "ignore" },
  );

  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch {}
      reject(new Error("Tunnel timed out after 30s"));
    }, 30_000);

    let buffer = "";
    let found = false;
    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (found) continue;
          buffer += decoder.decode(value, { stream: true });
          const match = buffer.match(TUNNEL_URL_REGEX);
          if (match) {
            found = true;
            buffer = "";
            clearTimeout(timeout);
            resolve(match[0]);
          }
        }
        if (!found) {
          clearTimeout(timeout);
          reject(new Error("cloudflared exited without tunnel URL"));
        }
      } catch (e) {
        if (!found) { clearTimeout(timeout); reject(e); }
      }
    };
    read();
  });

  return { process: proc, url };
}

/** Register a spawned tunnel in the shared map with auto-cleanup on exit. */
export function registerTunnel(port: number, proc: import("bun").Subprocess, url: string) {
  activeTunnels.set(port, {
    port, url, process: proc, pid: proc.pid, startedAt: Date.now(), probeFailures: 0,
  });
  proc.exited.then(() => activeTunnels.delete(port)).catch(() => activeTunnels.delete(port));
}
