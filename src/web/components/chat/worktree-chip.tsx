/**
 * The footer chip for a chat's git worktree. Before a new Claude chat's first message it is a
 * switch — *Worktree* runs the chat in `<project>/.claude/worktrees/<name>` on a branch of its own,
 * so it never edits the checkout another chat is working in. Once the chat runs in one, it names
 * the branch, and a tap copies the worktree's path.
 */
import { toast } from "sonner";
import { GitBranch } from "@/lib/icons";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { SessionWorktree } from "../../../shared/session-worktree";
import { FOOTER_CHIP, HIDE_NARROW } from "./footer-chip";

export function WorktreeChip({ worktree, canChoose, wanted, onWantedChange }: {
  worktree: SessionWorktree | null;
  /** A new Claude chat that has sent nothing yet: the switch is offered. */
  canChoose: boolean;
  wanted: boolean;
  onWantedChange: (wanted: boolean) => void;
}) {
  if (worktree) {
    return (
      <button
        type="button"
        onClick={() => void copyToClipboard(worktree.path).then((ok) => (ok ? toast.success("Worktree path copied") : toast.error("Could not copy the path")))}
        title={"This chat works in its own worktree: " + worktree.path + " (branch " + worktree.branch + "). Click to copy the path."}
        aria-label={"Worktree " + worktree.branch + ", copy its path"}
        data-worktree-chip="on"
        className={FOOTER_CHIP}
      >
        <GitBranch className="text-primary" />
        <span className="truncate max-w-40">{worktree.branch}</span>
      </button>
    );
  }
  if (!canChoose) return null;
  return (
    <button
      type="button"
      onClick={() => onWantedChange(!wanted)}
      aria-pressed={wanted}
      title={wanted
        ? "This chat will run in a new git worktree of its own. Click to work in the project's checkout instead."
        : "Run this chat in a new git worktree of its own, so it never edits the checkout other chats work in"}
      data-worktree-chip={wanted ? "wanted" : "off"}
      className={cn(FOOTER_CHIP, wanted && "border-accent-wash-border bg-accent-wash text-text")}
    >
      <GitBranch className={wanted ? "text-primary" : "text-text-3"} />
      <span className={HIDE_NARROW}>{wanted ? "New worktree" : "Worktree"}</span>
    </button>
  );
}
