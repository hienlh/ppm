import { useEffect } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useFileStore, relativeProjectPath } from "@/stores/file-store";
import { onFsChanged } from "@/components/os-explorer/explorer-store";

/** Keep on-demand indexes fresh even while the mobile file drawer is closed. */
export function useFileIndexInvalidation(): void {
  useEffect(() => {
    const changed = (event: Event) => {
      const projectName = (event as CustomEvent).detail?.projectName;
      const store = useFileStore.getState();
      if (projectName && projectName === store.indexProjectName) store.invalidateIndex();
    };
    window.addEventListener("file:changed", changed);
    const unsubscribeFs = onFsChanged((directory) => {
      const store = useFileStore.getState();
      const project = useProjectStore.getState().projects.find((p) => p.name === store.indexProjectName);
      if (project && relativeProjectPath(project.path, directory) !== null) store.invalidateIndex();
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
