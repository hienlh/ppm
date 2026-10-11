import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

/**
 * How the git tools are described to the agent, in the order of `GIT_TOOLS`. Definitions only, so
 * the tool list can be built without loading what the tools reach (handlers:
 * `assistant-git-tools.ts`).
 */
export const GIT_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [];
