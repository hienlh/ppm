import type { Json } from "../mcp-http-endpoint.ts";
import {
  JIRA_CONFIG_GET_TOOL, PPM_LOGS_SEARCH_TOOL, PPM_MEMORY_REPORT_TOOL, PPM_STATUS_TOOL, SYSTEM_RESOURCES_TOOL,
} from "../../shared/assistant-system-tool-names.ts";
import type { RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandler, FamilyHandlers, ToolContext } from "./assistant-tool-family.ts";
import { errorResult } from "./assistant-tool-output.ts";
import { ppmStatus } from "./assistant-system-status-tool.ts";
import { ppmLogsSearch } from "./assistant-system-logs-tool.ts";
import { ppmMemoryReport } from "./assistant-system-memory-tool.ts";
import { systemResources } from "./assistant-system-resources-tool.ts";
import { jiraConfigGet } from "./assistant-jira-config-tool.ts";

/**
 * The system tools' handlers. They read PPM's and the machine's own state through services
 * directly and call none of PPM's routes, so `SYSTEM_ROUTES` is empty: a system tool's route
 * caller reaches nothing. All of them only read, so none asks the user.
 */
export const SYSTEM_ROUTES: readonly RouteRule[] = [];

type Run = (ctx: ToolContext, args: Record<string, unknown>) => Promise<Json>;

/** An unexpected failure is answered as a tool error rather than a 500. */
const guard = (run: Run): FamilyHandler => async (ctx, args) => {
  try {
    return await run(ctx, args);
  } catch (e) {
    return errorResult(`The tool failed: ${(e as Error).message}.`);
  }
};

export const SYSTEM_TOOL_HANDLERS: FamilyHandlers = {
  [PPM_STATUS_TOOL]: guard(() => ppmStatus()),
  [PPM_LOGS_SEARCH_TOOL]: guard((ctx, args) => ppmLogsSearch(args, ctx.signal)),
  [PPM_MEMORY_REPORT_TOOL]: guard((ctx, args) => ppmMemoryReport(args, ctx.signal)),
  [SYSTEM_RESOURCES_TOOL]: guard((_ctx, args) => systemResources(args)),
  [JIRA_CONFIG_GET_TOOL]: guard((ctx, args) => jiraConfigGet(ctx.sessionId, args)),
};
