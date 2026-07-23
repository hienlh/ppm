/**
 * Pure (I/O-free) helpers for the tunnel registry: cloudflared cmdline parsing,
 * metrics-port extraction, /quicktunnel response parsing, and source merging.
 *
 * Kept separate from tunnel-registry.service.ts so the logic is unit-testable
 * without spawning processes or hitting the network.
 *
 * Secret hygiene: only `--url`, `--metrics`, and a bare `run <name>` are ever
 * parsed. `--token` / `--credentials-file` values are never read or surfaced.
 */

export type TunnelSource = "ppm" | "app" | "external";

export interface TunnelEntry {
  pid: number;
  /** Target localhost port from `--url`, or null if not determinable. */
  port: number | null;
  /** Public trycloudflare URL if known/recovered, else null ("unknown"). */
  url: string | null;
  source: TunnelSource;
  /** App/supervisor tunnel — display-only, never stoppable from the panel. */
  protected: boolean;
  status: "running";
  startedAt?: number;
  /** Process identity for kill re-verify: Win32 CreationDate ticks / unix start time. */
  identity?: string;
  /** Named-tunnel reference (display only; never a token/credential). */
  runRef?: string | null;
}

export interface ParsedCmdline {
  targetPort: number | null;
  metricsAddr: string | null;
  runRef: string | null;
}

/** Split a command line into argv, respecting single/double quotes. */
function tokenize(cmdline: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmdline)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/** Extract a port number from a `--url` value (http://host:port, host:port). */
function portFromUrlValue(value: string): number | null {
  // Strip scheme if present.
  const stripped = value.replace(/^[a-z]+:\/\//i, "");
  const m = stripped.match(/:(\d{1,5})(?:\/|$)/);
  if (!m) return null;
  const port = parseInt(m[1]!, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Parse a cloudflared command line into the whitelisted fields we surface.
 * Everything not explicitly whitelisted (notably --token/--credentials-file)
 * is ignored and never returned.
 */
export function parseCloudflaredCmdline(cmdline: string): ParsedCmdline {
  const argv = tokenize(cmdline);
  let targetPort: number | null = null;
  let metricsAddr: string | null = null;
  let runRef: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--url" || arg === "-url") {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) targetPort = portFromUrlValue(v);
    } else if (arg.startsWith("--url=")) {
      targetPort = portFromUrlValue(arg.slice("--url=".length));
    } else if (arg === "--metrics") {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) metricsAddr = v;
    } else if (arg.startsWith("--metrics=")) {
      metricsAddr = arg.slice("--metrics=".length);
    } else if (arg === "run") {
      // `cloudflared tunnel run <name>` — capture the name ONLY if the next
      // token is a bare arg. `run --token <JWT>` yields no name and we never
      // touch the token value.
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) runRef = v;
    }
  }

  return { targetPort, metricsAddr, runRef };
}

/** Extract the port from a metrics address like "127.0.0.1:20241" or ":20243". */
export function extractMetricsPort(metricsAddr: string | null): number | null {
  if (!metricsAddr) return null;
  const m = metricsAddr.match(/:(\d{1,5})$/);
  if (!m) return null;
  const port = parseInt(m[1]!, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Parse a cloudflared metrics `/quicktunnel` response body into a public URL.
 * Validates the hostname is a trycloudflare domain before trusting it.
 */
export function parseQuickTunnelResponse(body: string): string | null {
  try {
    const data = JSON.parse(body) as { hostname?: unknown };
    const hostname = typeof data.hostname === "string" ? data.hostname : null;
    if (!hostname) return null;
    if (!/^[a-z0-9-]+\.trycloudflare\.com$/i.test(hostname)) return null;
    return `https://${hostname}`;
  } catch {
    return null;
  }
}

/** Source precedence: higher number wins on PID collision. */
const SOURCE_RANK: Record<TunnelSource, number> = { external: 0, ppm: 1, app: 2 };

/**
 * Merge per-source tunnel lists into one, deduped by PID.
 * On collision the higher-precedence source (app > ppm > external) wins its
 * source/protected flag, while url/port/identity are filled from whichever
 * entry has them (higher precedence preferred).
 */
export function mergeTunnelSources(sources: {
  external: TunnelEntry[];
  ppm: TunnelEntry[];
  app: TunnelEntry[];
}): TunnelEntry[] {
  const byPid = new Map<number, TunnelEntry>();
  // Insert in ascending precedence so higher-precedence overlays later.
  for (const entry of [...sources.external, ...sources.ppm, ...sources.app]) {
    const existing = byPid.get(entry.pid);
    if (!existing) {
      byPid.set(entry.pid, { ...entry });
      continue;
    }
    const winner = SOURCE_RANK[entry.source] >= SOURCE_RANK[existing.source] ? entry : existing;
    const other = winner === entry ? existing : entry;
    byPid.set(entry.pid, {
      ...winner,
      port: winner.port ?? other.port,
      url: winner.url ?? other.url,
      identity: winner.identity ?? other.identity,
      startedAt: winner.startedAt ?? other.startedAt,
      runRef: winner.runRef ?? other.runRef,
    });
  }
  return [...byPid.values()];
}
