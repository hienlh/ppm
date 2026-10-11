import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

/**
 * How the tunnel tools are described to the agent, in the order of `TUNNEL_TOOLS`. Definitions
 * only, so the tool list can be built without loading what the tools reach (handlers:
 * `assistant-tunnel-tools.ts`).
 */
export const TUNNEL_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [];
