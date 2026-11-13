/**
 * What the tunnel tools need to know about *this* PPM process that no route says exactly: which
 * forwards this process started, which ports are PPM's own, which database profile it runs, and
 * whether its login is on. Behind an interface so the tools' tests can state each fact; the real
 * one reads PPM's in-process registries.
 *
 * The modules are imported on first use, not at the top: this file is reached from the MCP
 * endpoint while the server starts, and `tunnel-spawn.ts`/`tailscale-app-service.ts` pull in
 * modules (the global WebSocket hub) that would close an import cycle at that moment.
 */

export interface OwnForward {
  pid: number;
  port: number;
  url: string | null;
  via: "cloudflare" | "tailscale";
}

export interface TunnelHost {
  /**
   * The forwards this process started and still holds — the only ones `port_forward_stop` may
   * stop. Read from the registries the routes keep, not from `GET /api/tunnels`, whose list is
   * cached for seconds and also shows other programs' cloudflared.
   */
  ownForwards(): Promise<OwnForward[]>;
  /** Every port PPM itself answers on: configured, public (edge) and the server's bound port. */
  ppmPorts(): Promise<number[]>;
  /** The database profile this server runs on; null for the default `ppm.db`. */
  dbProfile(): Promise<string | null>;
  /** PPM's own login (`auth.enabled`). */
  authEnabled(): Promise<boolean>;
}

const isPort = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;

/** A row of `GET /api/tunnels`, as far as `ownForwardsInList` reads it. */
export interface TunnelRow { pid?: unknown; port?: unknown; url?: unknown; source?: unknown; protected?: unknown; via?: unknown }

/**
 * The same forwards as `ownForwards()`, read from a server's `GET /api/tunnels?force=1` answer by
 * a process that is not that server (the `ppm forward` CLI). The registry marks a row `ppm` only
 * when the answering server's own map holds it, and every Tailscale row is a forward it started;
 * a `protected` row (PPM's public link) and every other program's cloudflared are never one.
 */
export function ownForwardsInList(rows: readonly TunnelRow[]): OwnForward[] {
  const out: OwnForward[] = [];
  for (const r of rows) {
    if (r.source !== "ppm" || r.protected === true) continue;
    if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid < 1 || !isPort(r.port)) continue;
    out.push({ pid: r.pid, port: r.port, url: typeof r.url === "string" ? r.url : null, via: r.via === "tailscale" ? "tailscale" : "cloudflare" });
  }
  return out;
}

/**
 * The one forward of this PPM that `args` (`pid` or `port`) names, or why there is none — the rule
 * every stop goes through: a forward this PPM did not start is never stopped. `DELETE
 * /api/tunnels/:pid` kills any cloudflared on the machine that is not marked protected, and once
 * killed a production tunnel that way, so the check runs before that route is called.
 */
export function pickOwnForward(own: OwnForward[], args: Record<string, unknown>): OwnForward | string {
  const hasPort = args.port !== undefined && args.port !== null;
  const hasPid = args.pid !== undefined && args.pid !== null;
  if (hasPort === hasPid) return "Give exactly one of `port` or `pid`.";
  if (hasPid) {
    const pid = args.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return "`pid` must be a positive whole number.";
    return own.find((f) => f.pid === pid)
      ?? `PID ${pid} is not a forward this PPM started. PPM's own public link, other PPMs' forwards and other programs' cloudflared are never stopped from here; stop it where it was started.`;
  }
  if (!isPort(args.port)) return "`port` must be a whole number from 1 to 65535.";
  const port = args.port;
  const matches = own.filter((f) => f.port === port);
  if (matches.length > 1) return `Port ${port} is forwarded ${matches.length} ways (pids ${matches.map((f) => `${f.pid} via ${f.via}`).join(", ")}); give the \`pid\` of the one to stop.`;
  return matches[0] ?? `This PPM does not forward port ${port}. Forwards it did not start are never stopped from here; tunnels_status lists what runs.`;
}

export const realTunnelHost: TunnelHost = {
  async ownForwards() {
    const [{ activeTunnels }, { listTailscaleForwards }] = await Promise.all([
      import("../../server/routes/tunnel-spawn.ts"),
      import("../port-forward/tailscale-forward.ts"),
    ]);
    const out: OwnForward[] = [];
    // The live process pid, as the route's own DELETE matches it.
    for (const t of activeTunnels.values()) out.push({ pid: t.process?.pid ?? t.pid, port: t.port, url: t.url, via: "cloudflare" });
    for (const f of listTailscaleForwards()) out.push({ pid: f.pid, port: f.port, url: f.url, via: "tailscale" });
    return out;
  },
  async ppmPorts() {
    const [{ configService }, { ppmPublicPort }, { resolveTargetPort }] = await Promise.all([
      import("../config.service.ts"),
      import("../tailscale/tailscale-app-service.ts"),
      import("../edge-target-resolver.ts"),
    ]);
    const ports = [configService.get("port"), ppmPublicPort(), resolveTargetPort()].filter(isPort);
    return [...new Set(ports)];
  },
  async dbProfile() {
    const { currentPpmInstance } = await import("../assistant/ppm-cli-reference.ts");
    return currentPpmInstance().profile;
  },
  async authEnabled() {
    const { configService } = await import("../config.service.ts");
    return configService.get("auth").enabled === true;
  },
};
