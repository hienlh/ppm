/**
 * Level 3 of the change tray: one file's individual edits.
 *
 * Each edit's header *is* the jump control — a full-width button, no separate button
 * box. The diff below it is `edit-diff-preview` reused unchanged, lazily imported so
 * highlight.js + jsdiff stay out of the main chunk.
 */
import { lazy, Suspense } from "react";
import { ArrowUp } from "lucide-react";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";

const EditDiffPreview = lazy(() => import("./edit-diff-preview"));

export function ChangeEditList({ change, onJump }: {
  change: TurnFileChange;
  onJump: (editRef: string) => void;
}) {
  return (
    <div>
      {change.edits.map((edit, i) => (
        <div key={edit.editRef ?? i}>
          <button
            type="button"
            disabled={!edit.editRef}
            onClick={() => edit.editRef && onJump(edit.editRef)}
            className="group flex min-h-11 w-full items-center gap-2 px-3 font-mono text-[10px] text-text-subtle transition-colors hover:bg-surface disabled:hover:bg-transparent"
          >
            <span>edit {i + 1} of {change.editCount}</span>
            <span className="h-px flex-1 bg-border-soft" />
            {edit.editRef && (
              <span className="flex items-center gap-1 group-hover:text-primary">
                <ArrowUp className="size-3" />
                jump
              </span>
            )}
          </button>
          <div className="mx-3 mb-1">
            <Suspense fallback={<div className="h-4" />}>
              <EditDiffPreview
                oldStr={edit.oldStr}
                newStr={edit.newStr}
                filePath={change.filePath}
              />
            </Suspense>
          </div>
        </div>
      ))}
    </div>
  );
}
