import { api, projectUrl } from "@/lib/api-client";
import { useTabStore } from "@/stores/tab-store";
import type { FileDirEntry } from "../../../types/project";

export function chooseRunInstructions(entries: FileDirEntry[]): string | undefined {
  const names = entries.filter((entry) => entry.type === "file").map((entry) => entry.name);
  const priorities = ["readme.md", "readme.markdown", "readme.txt", "readme", "readme.rst", "package.json"];
  return priorities.map((name) => names.find((candidate) => candidate.toLowerCase() === name)).find(Boolean);
}

/** Navigation only. Readiness comes from the actual editor/preview after loading. */
export async function openRunInstructions(projectName: string, stillCurrent: () => boolean): Promise<"opened" | "missing" | "stale"> {
  const entries = await api.get<FileDirEntry[]>(`${projectUrl(projectName)}/files/list`);
  if (!stillCurrent()) return "stale";
  const filePath = chooseRunInstructions(entries);
  if (!filePath) return "missing";
  useTabStore.getState().openTab({ type: "editor", title: filePath, projectId: projectName,
    metadata: { projectName, filePath }, closable: true });
  // Re-check already-open previews as well as newly mounted editors.
  requestAnimationFrame(() => window.dispatchEvent(new Event("ppm:onboarding-refresh")));
  return "opened";
}
