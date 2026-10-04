/**
 * Shown while a merge, rebase, cherry-pick, revert or `git am` is stopped part
 * way: what is happening, how many conflicts are left, and the two ways out.
 */
import { Check, Loader2, TriangleAlert } from "@/lib/icons";
import { OPERATION_NOUN, operationTitle } from "@/lib/git-changes-view";
import { Button } from "@/components/ui/button";
import type { GitOperation } from "../../../shared/git-changes";

export function GitOperationBanner({ operation, branch, conflicts, busy, onAbort, onContinue }: {
  operation: GitOperation;
  branch: string | null;
  conflicts: number;
  busy: string | null;
  onAbort: (anchor: HTMLElement) => void;
  onContinue: () => void;
}) {
  const noun = OPERATION_NOUN[operation.kind];
  return (
    <div className="mx-2 mt-2 flex shrink-0 flex-col gap-2 rounded-[10px] bg-warning/10 py-2.5 pl-3 pr-2.5 text-[12.5px] text-text-2">
      <div className="flex gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <b className="font-semibold text-text break-words">{operationTitle(operation, branch)}</b>
          <br />
          {conflicts
            ? `Resolve ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}, then continue.`
            : `No conflicts left. Continue to finish the ${noun}.`}
        </div>
      </div>
      <div className="flex justify-end gap-1.5">
        <Button
          variant="ghost"
          size="xs"
          className="max-md:h-11 max-md:px-3"
          disabled={!!busy}
          onClick={(e) => onAbort(e.currentTarget)}
        >
          Abort {noun}
        </Button>
        <Button size="xs" className="max-md:h-11 max-md:px-3" disabled={!!busy || conflicts > 0} onClick={onContinue}>
          {busy === "continue" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Continue
        </Button>
      </div>
    </div>
  );
}
