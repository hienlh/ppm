/**
 * The PPM Assistant's tunnel tools, in the order `tools/list` gives them. Spread into
 * `ASSISTANT_TOOLS` (`assistant-tool-names.ts`), which is what grants them to Claude and Codex;
 * definitions and handlers live in `src/services/assistant-mcp/assistant-tunnel-*.ts`.
 */
export const TUNNELS_STATUS_TOOL = "tunnels_status";
export const PORT_FORWARD_START_TOOL = "port_forward_start";
export const PORT_FORWARD_STOP_TOOL = "port_forward_stop";
export const PUBLIC_LINK_SET_TOOL = "public_link_set";

export const TUNNEL_TOOLS = [
  TUNNELS_STATUS_TOOL, PORT_FORWARD_START_TOOL, PORT_FORWARD_STOP_TOOL, PUBLIC_LINK_SET_TOOL,
] as const;
