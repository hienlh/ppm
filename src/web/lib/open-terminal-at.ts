import { usePanelStore } from "@/stores/panel-store";
import { basename } from "@/lib/utils";

/**
 * Open a shell in the bottom dock that starts in `dir` (absolute host path).
 *
 * Used by "Open in Terminal" in the OS explorer and the project tree. The dock
 * reveals itself and the tab is titled after the folder so several folder
 * terminals stay distinguishable. `projectName` keeps the tab scoped to the
 * project when the folder belongs to one; explorer folders outside any project
 * pass none and the server only receives the start directory.
 */
export function openTerminalAt(dir: string, projectName?: string | null): string {
  const title = basename(dir) || dir;
  return usePanelStore.getState().openInDock({
    type: "terminal",
    title,
    projectId: projectName ?? null,
    closable: true,
    metadata: { cwd: dir, ...(projectName ? { projectName } : {}) },
  });
}
