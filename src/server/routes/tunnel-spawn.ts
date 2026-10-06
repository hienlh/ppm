/**
 * Shared cloudflared quick-tunnel spawn logic + the active-tunnel registry map.
 *
 * Extracted from port-forwarding.ts so both the legacy `/api/preview/*` routes
 * and the new `/api/tunnels` registry routes reuse ONE spawn implementation and
 * ONE shared `activeTunnels` map (no duplicate spawn logic, no split-brain state).
 */
import { ensureCloudflared, getQuickTunnelArgsTo } from "../../services/cloudflared.service.ts";
import { startForwardHop, type ForwardHop } from "../../services/port-forward/forward-hop.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("tunnels");

export const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface ActiveTunnel {
  port: number;
  url: string;
  process: import("bun").Subprocess;
  /** OS PID of the cloudflared process — required for registry merge/kill by PID. */
  pid: number;
  startedAt: number;
  probeFailures: number;
  /** The hop cloudflared points at (see spawnTunnelProcess); stopped when cloudflared exits. */
  hop?: ForwardHop;
}

export const MAX_PROBE_FAILURES = 2;

/** Active PPM-spawned tunnels keyed by port — exported for testing + registry. */
export const activeTunnels = new Map<number, ActiveTunnel>();

// A Bun child outlives `process.exit` on Linux and macOS, which is how PPM leaves after a
// fatal error. A cloudflared left behind would keep its public URL pointed at the hop's port
// after the hop is gone, and so at whatever listens on that port next.
process.on("exit", () => {
  for (const tunnel of activeTunnels.values()) {
    try { tunnel.process.kill(); } catch { /* already gone */ }
  }
});

/**
 * Spawn cloudflared quick tunnel for a port, extract URL from stderr.
 *
 * cloudflared reaches the dev server through a forward hop. Aimed at `127.0.0.1:<port>`
 * directly it never showed a default Vite page: Vite 8 listens on `[::1]` only, and it
 * answers the trycloudflare Host with "Blocked request" (see forward-hop.ts).
 */
export async function spawnTunnelProcess(
  port: number,
  /** The cloudflared command as an argv prefix; tests run a stand-in through bun. */
  cloudflared?: string[],
): Promise<{ process: import("bun").Subprocess; url: string; hop: ForwardHop }> {
  const argv = cloudflared ?? [await ensureCloudflared()];
  const hop = startForwardHop(port);
  let proc: ReturnType<typeof spawnCloudflared>;
  try {
    proc = spawnCloudflared(argv, `http://127.0.0.1:${hop.port}`);
  } catch (error) {
    hop.stop();
    throw error;
  }

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
  }).catch((error) => {
    hop.stop();
    throw error;
  });
  hop.setPublicUrl(url);

  return { process: proc, url, hop };
}

const spawnCloudflared = (argv: string[], originUrl: string) =>
  Bun.spawn([...argv, ...getQuickTunnelArgsTo(originUrl)], { stderr: "pipe", stdout: "ignore", stdin: "ignore" });

/** Register a spawned tunnel in the shared map with auto-cleanup on exit. */
export function registerTunnel(port: number, proc: import("bun").Subprocess, url: string, hop?: ForwardHop) {
  activeTunnels.set(port, {
    port, url, process: proc, pid: proc.pid, startedAt: Date.now(), probeFailures: 0, hop,
  });
  const cleanup = () => {
    // Every stop path removes the entry before the child is gone, so one still registered
    // died on its own (a crash, or the quick tunnel expired) and its URL went dead with it.
    const unexpected = activeTunnels.get(port)?.process === proc;
    const exit = `cloudflared port=${port} pid=${proc.pid} exited code=${proc.exitCode}${proc.signalCode ? ` signal=${proc.signalCode}` : ""}`;
    if (unexpected) log.warn(`${exit} — ${url} is down`);
    else log.info(`${exit} (stopped by PPM)`);
    activeTunnels.delete(port); hop?.stop();
  };
  proc.exited.then(cleanup).catch(cleanup);
}
