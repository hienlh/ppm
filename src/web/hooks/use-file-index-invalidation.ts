import { useEffect } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useFileStore, relativeProjectPath } from "@/stores/file-store";
import { onFsChanged } from "@/components/os-explorer/explorer-store";

/**
 * Keep on-demand indexes fresh even while the mobile file drawer is closed. A change only marks
 * the index stale — it is refetched when something opens to read it, see `indexStale`.
 */
export function useFileIndexInvalidation(): void {
  useEffect(() => {
    const changed = (event: Event) => {
      const projectName = (event as CustomEvent).detail?.projectName;
      if (typeof projectName === "string") useFileStore.getState().markIndexStale(projectName);
    };
    window.addEventListener("file:changed", changed);
    const unsubscribeFs = onFsChanged((directory) => {
      const store = useFileStore.getState();
      const project = useProjectStore.getState().projects.find((p) => p.name === store.indexProject);
      if (project && relativeProjectPath(project.path, directory) !== null) store.markIndexStale(project.name);
    });
    const unsubscribeProject = useProjectStore.subscribe((state, previous) => {
      if (state.activeProject?.name !== previous.activeProject?.name) useFileStore.getState().reset();
    });
    return () => {
      window.removeEventListener("file:changed", changed);
      unsubscribeFs();
      unsubscribeProject();
    };
  }, []);
}
