/**
 * The error and warning counts, and the one action that opens the list.
 *
 * VS Code puts these at the far left of the status bar and opens the Problems
 * panel when they are clicked; this is that, in the same place, doing the same
 * thing. Both counts are shown even at zero, because "0 errors" is information
 * and a control that disappears when everything is fine is one the user never
 * learns is there.
 */
import { memo, useCallback } from "react";
import { AlertTriangle, CircleX } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/stores/panel-store";
import { useProblemsStore, filesForProject, problemCounts } from "@/stores/problems-store";
import { useProjectStore } from "@/stores/project-store";
import { cn } from "@/lib/utils";

/** Open the Problems list in the dock, or focus it if it is already there. */
export function useOpenProblems(): () => void {
  const openInDock = usePanelStore((s) => s.openInDock);

  return useCallback(() => {
    // `deriveTabId` gives this type a fixed id, so a second call focuses the
    // existing tab rather than stacking another list beside it.
    openInDock({ type: "problems", title: "Problems", projectId: null, closable: true });
  }, [openInDock]);
}

export const ProblemsStatus = memo(function ProblemsStatus() {
  const files = useProblemsStore(useShallow((s) => s.files));
  const activeProjectName = useProjectStore((s) => s.activeProject?.name ?? null);
  const openProblems = useOpenProblems();
  // Scoped to the active project, so these counts and the panel's list agree.
  const { errors, warnings } = problemCounts(filesForProject(files, activeProjectName));

  return (
    <button
      onClick={openProblems}
      title={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} — open the Problems panel`}
      aria-label="Open the Problems panel"
      className="flex items-center gap-2 px-1 rounded-sm transition-colors hover:bg-accent/15 hover:text-text-primary shrink-0"
    >
      <span className={cn("flex items-center gap-1", errors > 0 && "text-error")}>
        <CircleX className="size-[11px]" />
        {errors}
      </span>
      <span className={cn("flex items-center gap-1", warnings > 0 && "text-warning")}>
        <AlertTriangle className="size-[11px]" />
        {warnings}
      </span>
    </button>
  );
});
