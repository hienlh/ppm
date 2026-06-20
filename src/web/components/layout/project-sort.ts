import { Clock, ArrowDownUp, ArrowDownAZ } from "lucide-react";
import { resolveOrder, sortByRecent, type ProjectInfo, type SortMode } from "@/stores/project-store";

// Sort modes for the project list, shared by the desktop flyout and the
// mobile bottom sheet (SortMode + persistence live in the store).
export const SORT_OPTIONS: { mode: SortMode; label: string; Icon: typeof Clock }[] = [
  { mode: "recent", label: "Recent", Icon: Clock },
  { mode: "priority", label: "Priority", Icon: ArrowDownUp },
  { mode: "name", label: "Name", Icon: ArrowDownAZ },
];

/** Apply the selected sort to the full project list. */
export function applySort(
  projects: ProjectInfo[], customOrder: string[] | null, mode: SortMode,
): ProjectInfo[] {
  if (mode === "recent") return sortByRecent(projects);
  if (mode === "name") return [...projects].sort((a, b) => a.name.localeCompare(b.name));
  return resolveOrder(projects, customOrder); // priority = manual/custom order
}
