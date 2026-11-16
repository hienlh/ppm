/**
 * The PPM Assistant's read tools about PPM itself and the machine it runs on, in the order
 * `tools/list` gives them. Spread into `ASSISTANT_TOOLS` (`assistant-tool-names.ts`), which is
 * what grants them to Claude and Codex; definitions and handlers live in
 * `src/services/assistant-mcp/assistant-system-*.ts` and `assistant-jira-config-tool.ts`.
 */
export const PPM_STATUS_TOOL = "ppm_status";
export const PPM_LOGS_SEARCH_TOOL = "ppm_logs_search";
export const PPM_MEMORY_REPORT_TOOL = "ppm_memory_report";
export const SYSTEM_RESOURCES_TOOL = "system_resources";
export const JIRA_CONFIG_GET_TOOL = "jira_config_get";

export const SYSTEM_TOOLS = [
  PPM_STATUS_TOOL, PPM_LOGS_SEARCH_TOOL, PPM_MEMORY_REPORT_TOOL, SYSTEM_RESOURCES_TOOL, JIRA_CONFIG_GET_TOOL,
] as const;
