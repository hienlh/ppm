import type { Json } from "../mcp-http-endpoint.ts";
import {
  PORT_FORWARD_START_TOOL, PORT_FORWARD_STOP_TOOL, PUBLIC_LINK_SET_TOOL,
} from "../../shared/assistant-tunnel-tool-names.ts";
import { forwardStartSummary, forwardStopSummary, publicLinkSummary } from "./assistant-approval-summary-tunnel.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import type { OwnForward, TunnelHost } from "./assistant-tunnel-host.ts";
import { readForwardOverTailscale, readPublicLink, readTailscale, shareableTailnetName } from "./assistant-tunnel-read-tools.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * The tunnel tools that change something: forward a port, stop a forward, switch PPM's public
 * link. Each reads the state through PPM's routes, builds its card from that, asks, and only on
 * an approval calls the route the UI calls. Three limits are this file's own, on top of the
 * routes' checks, because the routes were written for a person looking at the panel:
 *
 *  - PPM's own port is never forwarded: a second public address for PPM that nobody manages
 *    would outlive the user's memory of it. The public link is the managed one.
 *  - Only forwards this PPM process started are stopped. `DELETE /api/tunnels/:pid` kills any
 *    cloudflared on the machine that is not marked protected — another program's, another PPM's
 *    — and once killed a production tunnel that way. The check runs before the route is called.
 *  - The public link is not switched from a PPM on a non-default database profile: such a server
 *    shares `<ppm dir>/.supervisor-cmd` and `status.json` with the instance that owns the folder,
 *    so its reload request would restart *that* instance's tunnel. Nor is it switched on while
 *    PPM's login is off, which would hand the machine to whoever finds the address.
 */

const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

export async function portForwardStart(ctx: ToolContext, args: Record<string, unknown>, host: TunnelHost): Promise<Json> {
  const { port } = args;
  const via: unknown = args.via ?? "cloudflare";
  if (!isPort(port)) return errorResult("`port` must be a whole number from 1 to 65535.");
  if (via !== "cloudflare" && via !== "tailscale") return errorResult("`via` must be \"cloudflare\" or \"tailscale\".");

  if ((await host.ppmPorts()).includes(port)) {
    return errorResult(`Port ${port} is PPM's own port. Forwarding it would give PPM a second public address nobody manages; use public_link_set to switch PPM's public link instead.`);
  }
  const existing = (await host.ownForwards()).find((f) => f.port === port && f.via === via);
  if (existing) return jsonResult({ outcome: "already-forwarded", port, via, url: existing.url, pid: existing.pid });

  let tailnet: string | null = null;
  let dnsName: string | null = null;
  if (via === "tailscale") {
    const transport = await readForwardOverTailscale(ctx.callRoute);
    if ("error" in transport) return errorResult(`Could not check Tailscale: ${transport.error}`);
    if (!transport.available) return errorResult(`Port ${port} cannot be forwarded over Tailscale: ${transport.reason ?? "Tailscale is not ready on this machine"}.`);
    dnsName = transport.dnsName;
    const state = await readTailscale(ctx.callRoute);
    // The state's name is already shareable (never an email address); the MagicDNS suffix of
    // this machine's name stands in when the state has none or could not be read.
    tailnet = ("error" in state ? null : state.tailnet ?? null)
      ?? shareableTailnetName(null, dnsName?.split(".").slice(1).join(".") || null);
  }

  const verdict = await ctx.ask({
    tool: PORT_FORWARD_START_TOOL,
    input: { port, via },
    summary: forwardStartSummary({ port, via, tailnet, dnsName }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`forward port ${port} over ${via}`, verdict);

  const r = await ctx.callRoute<{ port?: unknown; url?: unknown; via?: unknown }>("POST", "/api/tunnels", { port, via });
  if (!r.ok) return errorResult(`The forward did not start: ${r.error ?? `PPM answered ${r.status}`}`);
  return jsonResult({
    outcome: "forwarded",
    port,
    via,
    url: typeof r.data?.url === "string" ? r.data.url : null,
    reachableBy: via === "tailscale" ? "devices on the user's tailnet" : "anyone with the address (no PPM login)",
    note: "It runs until stopped with port_forward_stop or until PPM restarts.",
  });
}

/** The one forward of this PPM that `args` names, or why there is none. */
function pickOwnForward(own: OwnForward[], args: Record<string, unknown>): OwnForward | string {
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

export async function portForwardStop(ctx: ToolContext, args: Record<string, unknown>, host: TunnelHost): Promise<Json> {
  const target = pickOwnForward(await host.ownForwards(), args);
  if (typeof target === "string") return errorResult(target);

  const verdict = await ctx.ask({
    tool: PORT_FORWARD_STOP_TOOL,
    input: { port: target.port, pid: target.pid },
    summary: forwardStopSummary({ port: target.port, pid: target.pid, via: target.via, url: target.url }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`stop forwarding port ${target.port}`, verdict);

  // The card may have waited for hours: the forward could have ended and its pid gone to an
  // unrelated process. Stop only what is still the very forward the user saw.
  const still = (await host.ownForwards()).find((f) => f.pid === target.pid && f.port === target.port && f.via === target.via);
  if (!still) {
    return jsonResult({ outcome: "stale", port: target.port, pid: target.pid, note: "That forward is no longer this PPM's (it ended while the card waited). Nothing was stopped." });
  }
  const r = await ctx.callRoute("DELETE", `/api/tunnels/${target.pid}`);
  if (!r.ok) return errorResult(`The forward was not stopped: ${r.error ?? `PPM answered ${r.status}`}`);
  return jsonResult({ outcome: "stopped", port: target.port, pid: target.pid, via: target.via, url: target.url });
}

const RELOAD_NOTES: Record<string, string> = {
  sent: "The change takes a few seconds to apply; check tunnels_status.",
  busy: "Saved, but PPM's supervisor still has another command waiting; the switch applies after it. Check tunnels_status in a little while.",
  "no-supervisor": "Saved; no supervisor runs this PPM, so it applies at the next `ppm start`.",
};

export async function publicLinkSet(ctx: ToolContext, args: Record<string, unknown>, host: TunnelHost): Promise<Json> {
  const { enabled } = args;
  if (typeof enabled !== "boolean") return errorResult("`enabled` must be true or false.");
  const profile = await host.dbProfile();
  if (profile !== null) {
    return errorResult(`This PPM runs on the "${profile}" database profile and shares its folder with the PPM that owns it: switching the public link from here would restart that other instance's tunnel. Switch it from the PPM that owns the folder.`);
  }
  const link = await readPublicLink(ctx.callRoute);
  if ("error" in link) return errorResult(`Could not read the public link's state: ${link.error}`);
  if (link.enabled === enabled) return jsonResult({ outcome: "unchanged", enabled, active: link.active, url: link.url });
  if (enabled && !(await host.authEnabled())) {
    return errorResult("PPM's login is off, so a public address would let anyone who finds it control this machine. Turn the login on in Settings first.");
  }

  const verdict = await ctx.ask({
    tool: PUBLIC_LINK_SET_TOOL,
    input: { enabled },
    summary: publicLinkSummary({ enabled, mode: link.mode, hostname: link.hostname, url: link.url }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`switch PPM's public link ${enabled ? "on" : "off"}`, verdict);

  // Re-checked: the login may have been switched off while the card waited.
  if (enabled && !(await host.authEnabled())) {
    return jsonResult({ outcome: "stale", enabled: false, note: "PPM's login was switched off while the card waited, so the public link stays off. Nothing was changed." });
  }
  const r = await ctx.callRoute<{ enabled?: unknown; reload?: unknown }>("POST", "/api/tunnel/enabled", { enabled });
  if (!r.ok) return errorResult(`The public link was not switched: ${r.error ?? `PPM answered ${r.status}`}`);
  const reload = typeof r.data?.reload === "string" ? r.data.reload : "unknown";
  return jsonResult({ outcome: "switched", enabled, reload, note: RELOAD_NOTES[reload] ?? "Check tunnels_status for the result." });
}
