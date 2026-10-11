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
