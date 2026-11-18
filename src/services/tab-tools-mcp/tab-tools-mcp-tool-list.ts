/**
 * Every tool `/api/tab-tools-mcp` (`ppm-tabs`) lists, in `tools/list` order. Kept apart from the
 * endpoint, which reaches the terminal service, so the chat's card coverage test reads the very list
 * the server serves (`tests/unit/web/ppm-tool-card-coverage.test.ts`).
 */
import {
  OPEN_FILE_TOOL_DEFINITION, OPEN_PREVIEW_TOOL_DEFINITION, OPEN_URL_TOOL_DEFINITION, READ_TERMINAL_TOOL_DEFINITION,
  RUN_IN_TERMINAL_TOOL_DEFINITION,
} from "./tab-tools-mcp-tool.ts";
import { SESSION_HISTORY_TOOL_DEFINITIONS } from "./session-history-tool-definitions.ts";

export const TAB_TOOLS_MCP_TOOL_DEFINITIONS = [
  OPEN_FILE_TOOL_DEFINITION, OPEN_PREVIEW_TOOL_DEFINITION, OPEN_URL_TOOL_DEFINITION,
  READ_TERMINAL_TOOL_DEFINITION, RUN_IN_TERMINAL_TOOL_DEFINITION, ...SESSION_HISTORY_TOOL_DEFINITIONS,
];
