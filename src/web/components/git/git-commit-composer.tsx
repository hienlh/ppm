/**
 * The commit message box and its split button.
 *
 * The message is the repository's one shared draft (`useCommitDraft`), so the
 * same text is in Source Control, the Review tab and the Git Graph inspector,
 * and survives a reload. The button commits what is staged — nothing is
 * staged implicitly — and its menu holds the variants: push after, amend,
 * sign off, and taking the last commit back. The sparkle button in the box asks
 * the default AI provider for a message from what is staged and puts it in
 * the draft; it never commits.
 */
import { useState } from "react";
import { toast } from "sonner";
import { ArrowUpFromLine, Check, ChevronDown, Loader2, Pencil, Sparkles, Undo2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import { useCommitDraft } from "@/hooks/use-commit-draft";
import { useGitRepo } from "@/hooks/use-git-repo";
import { useCommitDraftStore } from "@/stores/commit-draft-store";
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
  const gitRepo = useGitRepo(projectName);
  const [drafting, setDrafting] = useState(false);
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
  const draftMessage = async () => {
    if (drafting || totals.filesStaged === 0) return;
    const draftUrl = gitRepo.gitUrl("/commit-draft");
    const typed = () => useCommitDraftStore.getState().drafts[draftUrl]?.message ?? "";
    const before = typed();
    setDrafting(true);
    try {
      const { message } = await api.post<{ message: string }>(gitRepo.gitUrl("/commit-message"));
      // Typed into while the AI worked: keep what was typed rather than overwrite it.
      if (typed() !== before) {
        toast("Message drafted, but not used", { description: "The box was edited while it was being written." });
        return;
      }
      draft.setMessage(message);
    } catch (e) {
      toast.error("Could not draft a commit message", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setDrafting(false);
    }
  };
  const undo = async () => {
    await onUndoCommit();
    // The server put the undone commit's message back, if the box was empty.
    await draft.reload();
  };

  return (
    <div className={cn("flex flex-col gap-2 p-2.5", className)}>
      <div className="relative">
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
          readOnly={drafting}
          className="block min-h-[52px] md:min-h-[58px] max-h-[140px] w-full resize-none rounded-[10px] border border-border bg-background py-2 pl-2.5 pr-11 md:pr-8 text-base md:text-[13px] leading-[1.45] text-text outline-none [field-sizing:content] placeholder:text-text-3 focus:border-primary"
        />
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1 size-10 md:size-7 text-text-3 hover:text-text"
          disabled={drafting || !!busy || totals.filesStaged === 0}
          onClick={() => void draftMessage()}
          aria-label="Draft message with AI"
          title={totals.filesStaged === 0 ? "Stage changes to draft a message with AI" : "Draft a message from the staged changes with AI"}
        >
          {drafting ? <Loader2 className="animate-spin" /> : <Sparkles />}
        </Button>
      </div>
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
