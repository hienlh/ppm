/**
 * Forwarding a host port over Tailscale Serve: `https://<machine>.<tailnet>.ts.net:<port>/`,
 * reachable from the user's own tailnet only, with a real certificate, at a URL that stays
 * the same from one forward to the next.
 *
 * Each forward is a `tailscale serve` child run in the FOREGROUND, because a foreground
 * handler lives exactly as long as that process: tailscaled removes it when the process
 * goes, SIGKILL included (measured: gone from `serve status` 2 s after a `kill -9`). `--bg`
 * would persist the handler in tailscaled's prefs and outlive the hop it points at, leaving
 * a 502 on that port after any PPM restart until someone removed it by hand.
 *
 * The child does not end with PPM by itself, though: a Bun child outlives `process.exit` on
 * Linux and macOS, which is how PPM leaves after a fatal error. So every one still running is
 * killed on exit; only a SIGKILL of PPM itself can still leave one behind.
 *
 * The handler points at a forward hop, never at the dev server: Serve passes the tailnet
 * name through as Host, which Vite and webpack-dev-server refuse (see forward-hop.ts).
 */
import type { Runner } from "../host-info/spawn-runner.ts";
import { hostCli, isAccessDenied, runJson, type TailscaleCli } from "../tailscale/tailscale-cli.ts";
import { startForwardHop, type ForwardHop } from "./forward-hop.ts";
import { createLogger } from "../logger.ts";

// The same scope as the cloudflared forwards: both are rows of the one tunnels panel.
const log = createLogger("tunnels");

export type TailscaleAvailability =
  | { available: true; dnsName: string }
  | { available: false; reason: string };

export interface TailscaleForward {
  /** The dev server's port on the host. */
  port: number;
  /** The tailnet port Serve answers on; the dev server's own unless that one was taken. */
  servePort: number;
  url: string;
  pid: number;
  startedAt: number;
}

interface LiveForward extends TailscaleForward {
  process: ReturnType<typeof spawnServe>;
  hop: ForwardHop;
}

/** What `tailscale status --json` says about forwarding over Serve from this machine. */
export function parseTailscaleStatus(status: unknown): TailscaleAvailability {
  const s = status as { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown } | null;
  if (!s || typeof s !== "object") return { available: false, reason: "Could not read the Tailscale status on the host" };
  if (s.BackendState !== "Running") {
    const state = s.BackendState === "NeedsLogin" ? "signed out" : s.BackendState === "Stopped" ? "turned off" : "not connected";
    return { available: false, reason: `Tailscale is ${state} on the host` };
  }
  const dnsName = typeof s.Self?.DNSName === "string" ? s.Self.DNSName.replace(/\.$/, "") : "";
  if (!dnsName) return { available: false, reason: "MagicDNS is off in this tailnet" };
  const certDomains = Array.isArray(s.CertDomains) ? s.CertDomains : [];
  if (!certDomains.includes(dnsName)) {
    return { available: false, reason: "HTTPS certificates are off in this tailnet (Tailscale admin → DNS)" };
  }
  return { available: true, dnsName };
}

/** Every node port a Serve handler already answers on, background and foreground alike. */
export function parseServePorts(serveStatus: unknown): Set<number> {
  const used = new Set<number>();
  const config = serveStatus as { TCP?: Record<string, unknown>; Foreground?: Record<string, { TCP?: Record<string, unknown> }> } | null;
  const add = (tcp: Record<string, unknown> | undefined) => {
    for (const key of Object.keys(tcp ?? {})) {
      const port = Number(key);
      if (Number.isInteger(port)) used.add(port);
    }
  };
  add(config?.TCP);
  for (const session of Object.values(config?.Foreground ?? {})) add(session?.TCP);
  return used;
}

/** The dev server's own port when Serve has it free, else the next free one above it. */
export function pickServePort(targetPort: number, used: ReadonlySet<number>): number {
  for (let port = targetPort; port <= 65535; port++) if (!used.has(port)) return port;
  for (let port = 1024; port < targetPort; port++) if (!used.has(port)) return port;
  throw new Error("No free port left for Tailscale Serve");
}

/** The URL `tailscale serve` printed for the handler it opened (a refusal can print a login link). */
export function parseServeUrl(output: string): string | null {
  return output.match(/Available within your tailnet:\s+(https:\/\/\S+)/)?.[1] ?? null;
}

export async function readTailscaleAvailability(cli: TailscaleCli = hostCli()): Promise<TailscaleAvailability> {
  if (!cli.argv) return { available: false, reason: "Tailscale is not installed on the host" };
  try {
    return parseTailscaleStatus(await runJson(cli.runner, [...cli.argv, "status", "--json"]));
  } catch {
    return { available: false, reason: "Tailscale is not running on the host" };
  }
}

const spawnServe = (argv: string[], servePort: number, hopPort: number) =>
  Bun.spawn([...argv, "serve", `--https=${servePort}`, `http://127.0.0.1:${hopPort}`], {
    stdout: "pipe", stderr: "pipe", stdin: "ignore", windowsHide: true,
  });

const SERVE_READY_TIMEOUT_MS = 10_000;
const SERVE_POLL_MS = 250;

/** Append what a stream prints to `sink` until it ends. */
function collectOutput(stream: ReadableStream<Uint8Array>, sink: { text: string }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.text += decoder.decode(value, { stream: true });
      }
    } catch { /* the process went away */ }
  })();
}

/**
 * Wait until tailscaled lists a handler on `servePort`. Asked of tailscaled rather than read
 * from the CLI's output, whose wording is not an interface; the output is kept for errors.
 */
async function waitForHandler(
  runner: Runner, argv: string[], servePort: number, proc: ReturnType<typeof spawnServe>,
): Promise<"ready" | "exited" | "timeout"> {
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(SERVE_POLL_MS);
    if (exited) return "exited";
    const status = await runJson(runner, [...argv, "serve", "status", "--json"]).catch(() => null);
    if (status && parseServePorts(status).has(servePort)) return "ready";
  }
  return "timeout";
}

/** Turn the CLI's refusal into something a person can act on. */
export function serveFailureMessage(output: string): string {
  const text = output.trim();
  if (isAccessDenied(text)) {
    return "Tailscale refused to let PPM run `tailscale serve`. Run `sudo tailscale set --operator=$USER` once on the host, then try again.";
  }
  if (/serve is not enabled/i.test(text)) {
    const link = text.match(/https:\/\/login\.tailscale\.com\S*/)?.[0];
    return `Tailscale Serve is not enabled in this tailnet${link ? `: enable it at ${link}` : ""}.`;
  }
  return text ? `tailscale serve failed: ${text.split("\n").slice(0, 3).join(" ")}` : "tailscale serve exited without opening the port";
}

const forwards = new Map<number, LiveForward>();
const starting = new Map<number, Promise<TailscaleForward>>();
/** Every `tailscale serve` child still running, a forward still starting included. */
const serveChildren = new Set<ReturnType<typeof spawnServe>>();
/**
 * The serve port of every child in `serveChildren`. tailscaled lists a port only once its
 * handler is up, so two forwards starting together would otherwise both pick the same free one.
 */
const heldServePorts = new Set<number>();

process.on("exit", () => {
  for (const proc of serveChildren) {
    try { proc.kill(); } catch { /* already gone */ }
  }
});

function snapshot(f: LiveForward): TailscaleForward {
  return { port: f.port, servePort: f.servePort, url: f.url, pid: f.pid, startedAt: f.startedAt };
}

export function listTailscaleForwards(): TailscaleForward[] {
  return [...forwards.values()].map(snapshot);
}

/** Forward `targetPort` over Tailscale Serve, or answer with the forward already running for it. */
export function startTailscaleForward(targetPort: number, cli: TailscaleCli = hostCli()): Promise<TailscaleForward> {
  const existing = forwards.get(targetPort);
  if (existing) return Promise.resolve(snapshot(existing));
  const pending = starting.get(targetPort);
  if (pending) return pending;
  const attempt = openForward(targetPort, cli).finally(() => starting.delete(targetPort));
  starting.set(targetPort, attempt);
  return attempt;
}

async function openForward(targetPort: number, cli: TailscaleCli): Promise<TailscaleForward> {
  const availability = await readTailscaleAvailability(cli);
  if (!availability.available) throw new Error(availability.reason);
  const argv = cli.argv!;
  const used = parseServePorts(await runJson(cli.runner, [...argv, "serve", "status", "--json"]));
  const servePort = pickServePort(targetPort, new Set([...used, ...heldServePorts]));

  const hop = startForwardHop(targetPort);
  let proc: ReturnType<typeof spawnServe>;
  try {
    proc = spawnServe(argv, servePort, hop.port);
  } catch (error) {
    hop.stop();
    throw error;
  }
  // Nothing since the pick has awaited, so no other forward has picked this port meanwhile.
  heldServePorts.add(servePort);
  serveChildren.add(proc);
  void proc.exited.then(() => {
    serveChildren.delete(proc);
    heldServePorts.delete(servePort);
  });
  const output = { text: "" };
  collectOutput(proc.stdout, output);
  collectOutput(proc.stderr, output);
  const outcome = await waitForHandler(cli.runner, argv, servePort, proc);
  if (outcome !== "ready") {
    try { proc.kill(); } catch { /* already gone */ }
    hop.stop();
    // Give the readers a moment to drain what the CLI printed on its way out.
    await Bun.sleep(50);
    throw new Error(serveFailureMessage(output.text));
  }

  const forward: LiveForward = {
    port: targetPort,
    servePort,
    url: parseServeUrl(output.text) ?? `https://${availability.dnsName}${servePort === 443 ? "" : `:${servePort}`}/`,
    pid: proc.pid,
    startedAt: Date.now(),
    process: proc,
    hop,
  };
  hop.setPublicUrl(forward.url);
  forwards.set(targetPort, forward);
  log.info(`Tailscale forward port ${targetPort} → ${forward.url} (serve port ${servePort}, PID ${proc.pid})`);
  void proc.exited.then((code) => {
    // Still registered: nothing in PPM stopped it, and its URL has gone dead.
    if (forwards.get(targetPort) === forward) {
      forwards.delete(targetPort);
      log.warn(`Tailscale forward for port ${targetPort} ended: tailscale serve PID ${proc.pid} exited code=${code}${proc.signalCode ? ` signal=${proc.signalCode}` : ""}`);
    }
    hop.stop();
  });
  return snapshot(forward);
}

/** Stop the forward whose `tailscale serve` child is `pid`; false when PPM owns no such forward. */
export function stopTailscaleForwardByPid(pid: number): boolean {
  for (const forward of forwards.values()) {
    if (forward.pid !== pid) continue;
    forwards.delete(forward.port);
    try { forward.process.kill(); } catch { /* already gone */ }
    forward.hop.stop();
    log.info(`Tailscale forward port ${forward.port} stopped (PID ${pid})`);
    return true;
  }
  return false;
}

export function stopAllTailscaleForwards(): void {
  for (const forward of [...forwards.values()]) stopTailscaleForwardByPid(forward.pid);
}
