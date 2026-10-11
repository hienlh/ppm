import type { Json } from "../mcp-http-endpoint.ts";
import {
  PORT_FORWARD_START_TOOL, PORT_FORWARD_STOP_TOOL, PUBLIC_LINK_SET_TOOL, TUNNELS_STATUS_TOOL,
} from "../../shared/assistant-tunnel-tool-names.ts";
import { allowRoute, type RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandler, FamilyHandlers, ToolContext } from "./assistant-tool-family.ts";
import { realTunnelHost, type TunnelHost } from "./assistant-tunnel-host.ts";
import { tunnelsStatus } from "./assistant-tunnel-read-tools.ts";
import { portForwardStart, portForwardStop, publicLinkSet } from "./assistant-tunnel-write-tools.ts";
import { errorResult } from "./assistant-tool-output.ts";

/**
 * The tunnel tools' handlers and the only routes they may call. `TUNNEL_ROUTES` is this family's
 * whole reach into PPM's routes (see `assistant-route-call.ts`). Named-tunnel setup and the
 * Tailscale Service switch are read here but never changed: both need steps only the user can
 * take (a Cloudflare or Tailscale sign-in, an admin's approval), so they stay in Settings.
 */
export const TUNNEL_ROUTES: readonly RouteRule[] = [
  allowRoute("GET", "/api/tunnels", ["force"]),
  allowRoute("GET", "/api/tunnels/transports"),
  allowRoute("POST", "/api/tunnels"),
  allowRoute("DELETE", "/api/tunnels/:pid"),
  allowRoute("GET", "/api/tunnel"),
  allowRoute("POST", "/api/tunnel/enabled"),
  allowRoute("GET", "/api/tunnel/named/status"),
  allowRoute("GET", "/api/tailscale/state"),
];

type HostedHandler = (ctx: ToolContext, args: Record<string, unknown>, host: TunnelHost) => Promise<Json>;

/** A handler bound to `host`, answering an unexpected failure as a tool error rather than a 500. */
const bind = (run: HostedHandler, host: TunnelHost): FamilyHandler => async (ctx, args) => {
  try {
    return await run(ctx, args, host);
  } catch (e) {
    return errorResult(`The tunnel tool failed: ${(e as Error).message}. Nothing more was done.`);
  }
};

/** The handlers over a given host; tests pass their own, PPM passes the process's registries. */
export function createTunnelToolHandlers(host: TunnelHost = realTunnelHost): FamilyHandlers {
  return {
    [TUNNELS_STATUS_TOOL]: bind((ctx, _args, h) => tunnelsStatus(ctx, h), host),
    [PORT_FORWARD_START_TOOL]: bind(portForwardStart, host),
    [PORT_FORWARD_STOP_TOOL]: bind(portForwardStop, host),
    [PUBLIC_LINK_SET_TOOL]: bind(publicLinkSet, host),
  };
}

export const TUNNEL_TOOL_HANDLERS: FamilyHandlers = createTunnelToolHandlers();
