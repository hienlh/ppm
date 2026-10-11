import {
  PORT_FORWARD_START_TOOL, PORT_FORWARD_STOP_TOOL, PUBLIC_LINK_SET_TOOL, TUNNELS_STATUS_TOOL,
} from "../../shared/assistant-tunnel-tool-names.ts";
import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

/**
 * How the tunnel tools are described to the agent, in the order of `TUNNEL_TOOLS`. Definitions
 * only, so the tool list can be built without loading what the tools reach (handlers:
 * `assistant-tunnel-tools.ts`).
 */

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const PORT = { type: "integer", minimum: 1, maximum: 65535, description: "The localhost port a dev server listens on." };

export const TUNNEL_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [
  {
    name: TUNNELS_STATUS_TOOL,
    title: "Show tunnels and port forwards",
    description: "Read how this PPM can be reached and what it forwards: PPM's own public link (on or off, its "
      + "address, quick or named tunnel), whether PPM's login is on, Tailscale's state and PPM's Tailscale address, "
      + "whether a port can be forwarded over Tailscale, and every port forward running on the machine "
      + "(`ownedByThisPpm` marks the ones this PPM started, the only ones port_forward_stop can stop). Asks nothing.",
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: PORT_FORWARD_START_TOOL,
    title: "Forward a localhost port",
    description: "Make a dev server on this machine reachable from elsewhere. `via: \"cloudflare\"` (the default) gives "
      + "a random public https://….trycloudflare.com address anyone can open, with no PPM login in front of it; "
      + "`via: \"tailscale\"` gives an address only devices on the user's tailnet can open. Asks the user first; a "
      + "port this PPM already forwards answers at once. PPM's own port is refused: use public_link_set for that.",
    inputSchema: object({
      port: PORT,
      via: { type: "string", enum: ["cloudflare", "tailscale"], description: "How to forward it (default cloudflare)." },
    }, ["port"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: PORT_FORWARD_STOP_TOOL,
    title: "Stop a port forward",
    description: "Stop a port forward this PPM started, by its port or by the pid tunnels_status lists. Anyone using "
      + "its address loses it. Forwards started by another program or another PPM, and PPM's own public link, are "
      + "refused. Asks the user first.",
    inputSchema: object({
      port: PORT,
      pid: { type: "integer", minimum: 1, description: "The forward's pid, from tunnels_status." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: PUBLIC_LINK_SET_TOOL,
    title: "Switch PPM's public link on or off",
    description: "Switch PPM's own public address (its Cloudflare tunnel) on or off. On: anyone with the address "
      + "reaches PPM's login page, so it is refused while PPM's login is off. Off: everyone using PPM through that "
      + "address loses access. Refused on a PPM running a non-default database profile, which shares its folder "
      + "with another PPM. Asks the user first; takes a few seconds to apply, so check tunnels_status after.",
    inputSchema: object({
      enabled: { type: "boolean", description: "true to switch the public link on, false to switch it off." },
    }, ["enabled"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
];
