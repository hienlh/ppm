/**
 * Open (or focus) the project's Review changes tab, on `path` when given. An
 * open tab is only focused by `openTab`, so the file to show is written into
 * it afterwards — a new object each time, so asking for the same file again
 * still selects it.
 *
 * `repo` is for a caller looking at a repository other than the one Source
 * Control chose — the Git Graph of a sub-repository — so the tab reviews that
 * one instead of answering with another repository's changes.
 */
import { useTabStore } from "@/stores/tab-store";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";

export function openGitReview(projectName: string, path?: string, repo?: string): void {
  const patch = { select: path || repo ? { ...(path ? { path } : {}), ...(repo ? { repo } : {}), at: Date.now() } : undefined };
  const id = useTabStore.getState().openTab({
    type: "git-review",
    title: "Review changes",
    projectId: projectName,
    closable: true,
    metadata: { projectName, ...patch },
  });
  if (id && patch.select) patchTabMetadata(id, patch);
}
