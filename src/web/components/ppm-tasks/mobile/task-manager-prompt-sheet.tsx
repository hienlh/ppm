/**
 * "Tell the manager now?" on a phone: a small bottom sheet instead of the desktop toast, with
 * Tell now as the full-width primary button in the bottom third and Next turn under it. Swiping
 * the sheet away, or the backdrop, is Next turn: the manager reads the news on its next turn.
 * Shown by `TaskManagerPromptHost`, which asks once per burst of edits.
 */
import { Bot } from "@/lib/icons";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import type { TaskManagerPromptToastProps } from "../task-manager-prompt-toast";

export function TaskManagerPromptSheet({ project, sending, onAnswer }: TaskManagerPromptToastProps) {
  return (
    <BottomSheet open onClose={() => { if (!sending) onAnswer(false); }}>
      <div role="dialog" aria-label="Tell the manager now?" data-task-manager-prompt={project} className="px-4 pb-2 pt-1">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-2/12 text-accent-2"><Bot aria-hidden className="size-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-text">Tell the {project} manager now?</p>
            <p className="mt-0.5 text-sm text-text-2">Otherwise it reads your changes on its next turn.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" disabled={sending} onClick={() => onAnswer(true)}
            className="h-12 w-full rounded-xl bg-primary text-[15px] font-medium text-primary-foreground active:bg-primary/90 disabled:opacity-60">
            {sending ? "Telling…" : "Tell now"}
          </button>
          <button type="button" disabled={sending} onClick={() => onAnswer(false)}
            className="h-11 w-full rounded-xl border border-border text-[15px] text-text-2 active:bg-surface-hover disabled:opacity-60">
            Next turn
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
