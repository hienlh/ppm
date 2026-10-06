/**
 * The commit message box and its split button.
 *
 * The message is the repository's one shared draft (`useCommitDraft`), so the
 * same text is in Source Control, the Review tab and the Git Graph inspector,
 * and survives a reload. The button commits what is staged — nothing is
 * staged implicitly — and its menu holds the variants: push after, amend,
 * sign off, and taking the last commit back.
 */
import { ArrowUpFromLine, Check, ChevronDown, Loader2, Pencil, Undo2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useCommitDraft } from "@/hooks/use-commit-draft";
import { canCommit, commitHint, commitLabel, type ChangeTotals } from "@/lib/git-changes-view";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LastCommit } from "../../../shared/git-changes";

export interface CommitOptions {
  push?: boolean;
  amend?: boolean;
  signoff?: boolean;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const COMMIT_KEYS = IS_MAC ? "⌘↵" : "Ctrl+↵";

export function GitCommitComposer({ projectName, branch, totals, lastCommit, busy, onCommit, onUndoCommit, className }: {
  projectName: string;
  branch: string | null;
  totals: ChangeTotals;
  lastCommit: LastCommit | null;
  /** The action in flight, if any: every button waits for it. */
  busy: string | null;
  /** Resolves true once the commit is made, which is when the message is cleared — unless it was typed in meanwhile. */
  onCommit: (message: string, options: CommitOptions) => Promise<boolean>;
  onUndoCommit: () => Promise<void>;
  className?: string;
}) {
  const draft = useCommitDraft(projectName);
  const ready = canCommit(totals, draft.message) && !busy;
  // Both rewrite the last commit, so neither is offered once it is on the remote.
  const rewritable = !!lastCommit && !lastCommit.pushed;
  const amendable = rewritable && !busy && (totals.filesStaged > 0 || draft.message.trim() !== "");
  const undoable = rewritable && lastCommit.hasParent && !busy;

  const commit = async (options: CommitOptions = {}) => {
    if (options.amend ? !amendable : !ready) return;
    // A save still on the wire would land after the commit cleared the
    // message and put the committed text back.
    await draft.flush().catch(() => undefined);
    const message = draft.message.trim();
    if (await onCommit(message, options)) draft.consumed(message);
  };
  const undo = async () => {
    await onUndoCommit();
    // The server put the undone commit's message back, if the box was empty.
    await draft.reload();
  };

  return (
    <div className={cn("flex flex-col gap-2 p-2.5", className)}>
      <textarea
        rows={2}
        value={draft.message}
        onChange={(e) => draft.setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void commit();
          }
        }}
        placeholder={branch ? `Message (${COMMIT_KEYS} to commit on ${branch})` : `Message (${COMMIT_KEYS} to commit)`}
        aria-label="Commit message"
        className="block min-h-[52px] md:min-h-[58px] max-h-[140px] w-full resize-none rounded-[10px] border border-border bg-background px-2.5 py-2 text-base md:text-[13px] leading-[1.45] text-text outline-none [field-sizing:content] placeholder:text-text-3 focus:border-primary"
      />
      <div className="flex h-11 md:h-8">
        <Button
          className="h-full min-w-0 flex-1 rounded-r-none max-md:rounded-l-[10px] max-md:text-sm"
          disabled={!ready}
          onClick={() => void commit()}
        >
          {busy === "commit" ? <Loader2 className="animate-spin" /> : <Check />}
          <span className="truncate">{commitLabel(totals)}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="h-full w-11 md:w-8 rounded-l-none border-l border-white/20 px-0 max-md:rounded-r-[10px]"
              disabled={!!busy}
              aria-label="More commit actions"
              title="More commit actions"
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onClick={() => void commit({ push: true })} disabled={!ready}>
              <ArrowUpFromLine />
              Commit and push
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void commit({ amend: true })} disabled={!amendable}>
              <Pencil />
              Amend last commit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void commit({ signoff: true })} disabled={!ready}>
              <Check />
              Commit with sign-off
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void undo()} disabled={!undoable}>
              <Undo2 />
              Undo last commit
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="truncate text-[11.5px] text-text-3">{commitHint(totals, draft.message, COMMIT_KEYS)}</div>
    </div>
  );
}
