/**
 * The PPM Assistant's tools that change one of the user's chats, or review the file changes one
 * made, in the order `tools/list` gives them. Spread into `ASSISTANT_TOOLS`
 * (`assistant-tool-names.ts`), which is what grants them to Claude and Codex; definitions and
 * handlers live in `src/services/assistant-mcp/assistant-chat-*.ts`. Reading chats and answering
 * their cards are not in this family.
 */
export const CHAT_STOP_TOOL = "chat_stop";
export const CHAT_ORGANIZE_TOOL = "chat_organize";
export const CHAT_DELETE_TOOL = "chat_delete";
export const CHAT_CHANGES_TOOL = "chat_changes";
export const CHAT_CHANGES_ANSWER_TOOL = "chat_changes_answer";

export const CHAT_TOOLS = [
  CHAT_STOP_TOOL, CHAT_ORGANIZE_TOOL, CHAT_DELETE_TOOL, CHAT_CHANGES_TOOL, CHAT_CHANGES_ANSWER_TOOL,
] as const;
