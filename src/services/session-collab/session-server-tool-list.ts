/**
 * Every tool `/api/sessions-mcp` (`ppm-sessions`) lists, in `tools/list` order: the session tools,
 * the schedule tools, `report_to_assistant`, the vault's and the task store's. Kept apart from the
 * endpoint so the chat's card coverage test reads the very list the server serves
 * (`tests/unit/web/ppm-tool-card-coverage.test.ts`).
 */
import { reportToolDefinition } from "../assistant-cards/manager-report-tool.ts";
import { VAULT_TOOL_DEFINITIONS } from "../vault/vault-tools.ts";
import { PPM_TASK_TOOL_DEFINITIONS } from "../ppm-tasks/tools/ppm-task-tool-definitions.ts";
import { sessionScheduleToolDefinitions } from "./collab-schedule-tool-definitions.ts";
import { sessionCollabToolDefinitions } from "./session-collab-tool.ts";

export function sessionServerToolDefinitions() {
  return [...sessionCollabToolDefinitions(), ...sessionScheduleToolDefinitions(), reportToolDefinition(), ...VAULT_TOOL_DEFINITIONS, ...PPM_TASK_TOOL_DEFINITIONS];
}
