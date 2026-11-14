/**
 * The tools a chat's AI schedules prompts into its own chat with, served by the `ppm-sessions`
 * MCP server beside the session tools. Named apart from the PPM Assistant's `schedule_*` tools,
 * which manage every schedule of the install behind a card: these reach one chat only, the caller's.
 */
export const SESSION_SCHEDULE_CREATE_TOOL = "session_schedule_create";
export const SESSION_SCHEDULE_LIST_TOOL = "session_schedule_list";
export const SESSION_SCHEDULE_DELETE_TOOL = "session_schedule_delete";
export const SESSION_SCHEDULE_TOOLS = [
  SESSION_SCHEDULE_CREATE_TOOL, SESSION_SCHEDULE_LIST_TOOL, SESSION_SCHEDULE_DELETE_TOOL,
] as const;
export type SessionScheduleTool = (typeof SESSION_SCHEDULE_TOOLS)[number];

export const isSessionScheduleTool = (name: unknown): name is SessionScheduleTool =>
  (SESSION_SCHEDULE_TOOLS as readonly unknown[]).includes(name);

/**
 * Claude Code's own scheduling tools. Their jobs live in the CLI process (or a file only that CLI
 * reads), so they stop with it; PPM's survive restarts and wait until the chat is idle. `ScheduleWakeup`
 * is left alone: `/loop` runs on it, and it only ever wakes the turn that asked.
 */
export const CLAUDE_BUILTIN_CRON_TOOLS = ["CronCreate", "CronList", "CronDelete"] as const;
