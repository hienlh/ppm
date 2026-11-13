/**
 * The PPM Assistant's tools that give a project's manager-chat role to one of its existing chats,
 * or take it away, in the order `tools/list` gives them. Spread into `ASSISTANT_TOOLS`
 * (`assistant-tool-names.ts`); definitions and handlers live in
 * `src/services/assistant-mcp/assistant-manager-*.ts`. Creating a new manager chat is not here:
 * that is `create_session` with `manager: true`, on PPM's session tools.
 */
export const MANAGER_ASSIGN_TOOL = "manager_assign";
export const MANAGER_UNASSIGN_TOOL = "manager_unassign";

export const MANAGER_TOOLS = [MANAGER_ASSIGN_TOOL, MANAGER_UNASSIGN_TOOL] as const;
