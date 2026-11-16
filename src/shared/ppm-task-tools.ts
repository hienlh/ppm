/**
 * The AI's tools on PPM's own task store (the per-project list the user sees in PPM and on
 * Telegram). Served by the `ppm-sessions` MCP server beside the session and vault tools; one
 * switch each in Settings → Tools, group "Tasks", for every chat — manager chats and the PPM
 * Assistant included. Named `ppm_task_*` because the model already has built-in `TaskCreate` /
 * `TaskList` tools for its own to-do list, which are something else.
 */

export const PPM_TASK_LIST_TOOL = "ppm_task_list";
export const PPM_TASK_GET_TOOL = "ppm_task_get";
export const PPM_TASK_PROJECT_TOOL = "ppm_task_project";
export const PPM_TASK_CREATE_TOOL = "ppm_task_create";
export const PPM_TASK_UPDATE_TOOL = "ppm_task_update";
export const PPM_TASK_CLOSE_TOOL = "ppm_task_close";
export const PPM_TASK_REORDER_TOOL = "ppm_task_reorder";
export const PPM_TASK_UNDO_TOOL = "ppm_task_undo";
export const PPM_TASK_PROJECT_UPDATE_TOOL = "ppm_task_project_update";
/** The PPM Assistant only: wake a project's manager chat now about task changes, after the user said yes. */
export const PPM_TASK_NOTIFY_MANAGER_TOOL = "ppm_task_notify_manager";

export const PPM_TASK_READ_TOOLS = [PPM_TASK_LIST_TOOL, PPM_TASK_GET_TOOL, PPM_TASK_PROJECT_TOOL] as const;
export const PPM_TASK_WRITE_TOOLS = [
  PPM_TASK_CREATE_TOOL, PPM_TASK_UPDATE_TOOL, PPM_TASK_CLOSE_TOOL, PPM_TASK_REORDER_TOOL, PPM_TASK_UNDO_TOOL,
  PPM_TASK_PROJECT_UPDATE_TOOL, PPM_TASK_NOTIFY_MANAGER_TOOL,
] as const;
export const PPM_TASK_TOOLS = [...PPM_TASK_READ_TOOLS, ...PPM_TASK_WRITE_TOOLS] as const;
export type PpmTaskTool = (typeof PPM_TASK_TOOLS)[number];

export const isPpmTaskTool = (name: unknown): name is PpmTaskTool => (PPM_TASK_TOOLS as readonly unknown[]).includes(name);
export const isPpmTaskWriteTool = (name: unknown): boolean => (PPM_TASK_WRITE_TOOLS as readonly unknown[]).includes(name);
