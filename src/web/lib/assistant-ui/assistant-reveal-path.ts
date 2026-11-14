import { usePanelStore } from "@/stores/panel-store";
import { revealInExplorer } from "@/components/explorer/explorer-reveal";
import type { AssistantRevealPathResult } from "../../../shared/assistant-ui-protocol";
import { requireProject, showProject } from "./assistant-ui-actions";

/**
 * `reveal_path` on the device: bring the project up, put its Explorer on screen (the drawer on a
 * phone) and let the tree open the folders on the way and select the row. The server proved the
 * path lies inside the project; the tree then says whether it lists it.
 */
export async function revealAssistantPath(args: Record<string, unknown>): Promise<AssistantRevealPathResult> {
  const project = requireProject(args.project);
  const path = typeof args.path === "string" ? args.path : null;
  const kind = args.kind === "folder" || args.kind === "file" ? args.kind : null;
  if (path === null || kind === null || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error("`path` must be a path inside the project, as the server sends it.");
  }
  const previousProject = usePanelStore.getState().currentProject;
  showProject(project);
  const outcome = await revealInExplorer({ projectName: project.name, path, kind });
  if (!outcome.ok) throw new Error(outcome.error);
  return { path, kind, project: usePanelStore.getState().currentProject, previousProject };
}
