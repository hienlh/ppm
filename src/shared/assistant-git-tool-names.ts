/**
 * The PPM Assistant's git tools, in the order `tools/list` gives them. Spread into
 * `ASSISTANT_TOOLS` (`assistant-tool-names.ts`), which is what grants them to Claude and Codex;
 * definitions and handlers live in `src/services/assistant-mcp/assistant-git-*.ts`.
 */
export const GIT_STATUS_TOOL = "git_status";
export const GIT_LOG_TOOL = "git_log";
export const GIT_DIFF_TOOL = "git_diff";
export const GIT_BRANCHES_TOOL = "git_branches";
export const GIT_STAGE_TOOL = "git_stage";
export const GIT_DISCARD_TOOL = "git_discard";
export const GIT_UNDO_TOOL = "git_undo";
export const GIT_COMMIT_TOOL = "git_commit";
export const GIT_SYNC_TOOL = "git_sync";
export const GIT_BRANCH_TOOL = "git_branch";
export const GIT_STASH_TOOL = "git_stash";

export const GIT_TOOLS = [
  GIT_STATUS_TOOL, GIT_LOG_TOOL, GIT_DIFF_TOOL, GIT_BRANCHES_TOOL,
  GIT_STAGE_TOOL, GIT_DISCARD_TOOL, GIT_UNDO_TOOL, GIT_COMMIT_TOOL, GIT_SYNC_TOOL, GIT_BRANCH_TOOL, GIT_STASH_TOOL,
] as const;
