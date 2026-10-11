import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

/**
 * How the schedule tools are described to the agent, in the order of `SCHEDULE_TOOLS`.
 * Definitions only, so the tool list can be built without loading what the tools reach
 * (handlers: `assistant-schedule-tools.ts`).
 */
export const SCHEDULE_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [];
