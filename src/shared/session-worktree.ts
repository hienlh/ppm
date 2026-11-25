/**
 * A chat that runs in a git worktree of its own (Claude Code's `--worktree`): the CLI creates
 * `<project>/.claude/worktrees/<name>` on a new branch `worktree-<name>`, works there, and resumes
 * there every time after, so parallel chats never edit the same checkout.
 */
export interface SessionWorktree {
  name: string;
  /** The worktree's absolute path. */
  path: string;
  branch: string;
}

/** What a worktree name may be: one path segment that is also a valid branch-name part. */
export const WORKTREE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A fresh name for a chat's worktree: short, sortable by when it was made, unlikely to repeat. */
export function newWorktreeName(now = new Date(), random = Math.random): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = String(now.getFullYear()).slice(2) + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
  return "chat-" + stamp + "-" + Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
}
