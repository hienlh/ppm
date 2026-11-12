/**
 * The PPM Assistant's tools that change a registered project, in the order `tools/list` gives
 * them. Spread into `ASSISTANT_TOOLS` (`assistant-tool-names.ts`), which is what grants them to
 * Claude and Codex; definitions and handlers live in `src/services/assistant-mcp/assistant-project-*.ts`.
 * Adding a project (`project_add`) is not in this family: it registers a folder directly.
 */
export const PROJECT_UPDATE_TOOL = "project_update";
export const PROJECT_REMOVE_TOOL = "project_remove";

export const PROJECT_TOOLS = [PROJECT_UPDATE_TOOL, PROJECT_REMOVE_TOOL] as const;
