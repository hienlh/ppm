/**
 * The PPM Assistant's schedule tools, in the order `tools/list` gives them. Spread into
 * `ASSISTANT_TOOLS` (`assistant-tool-names.ts`), which is what grants them to Claude and Codex;
 * definitions and handlers live in `src/services/assistant-mcp/assistant-schedule-*.ts`.
 */
export const SCHEDULES_LIST_TOOL = "schedules_list";
export const SCHEDULE_GET_TOOL = "schedule_get";
export const SCHEDULE_SAVE_TOOL = "schedule_save";
export const SCHEDULE_DELETE_TOOL = "schedule_delete";
export const SCHEDULE_RUN_NOW_TOOL = "schedule_run_now";

export const SCHEDULE_TOOLS = [
  SCHEDULES_LIST_TOOL, SCHEDULE_GET_TOOL, SCHEDULE_SAVE_TOOL, SCHEDULE_DELETE_TOOL, SCHEDULE_RUN_NOW_TOOL,
] as const;
