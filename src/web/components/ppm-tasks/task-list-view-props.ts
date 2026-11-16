/**
 * What the Tasks sidebar panel hands to the list it renders: the desktop list now, and the phone
 * list P6 wires in beside it (`tasks-sidebar-panel.tsx`, one `useIsMobile()` branch). Both draw the
 * same groups from the same data and call back with the same actions.
 */
import type { TaskListGroup } from "@/lib/ppm-tasks/task-list-view";
import type { LinkState, Urgency } from "../../../shared/ppm-tasks";
import type { TaskDto, TaskWorkingSession } from "../../../shared/ppm-tasks-api";
import type { SettingsMap } from "./use-task-project-settings-map";

export interface TaskListViewProps {
  groups: TaskListGroup[];
  /** Every task the server sent (closed included), for child progress. */
  progress: Map<string, { done: number; total: number }>;
  showProject: boolean;
  selectedId: string | null;
  /** Statuses, members and fields of every project shown, by project name. */
  settings: SettingsMap;
  /** Live link states and working chats, by task id (fresher than the list's own). */
  live: Record<string, { linkStates: LinkState[]; workingSession: TaskWorkingSession }>;
  /** `keep`: Enter or a double-click, which keeps the tab instead of previewing. */
  onSelect(task: TaskDto, keep: boolean): void;
  onOpenChat(task: TaskDto, sessionId: string): void;
  onStartChat(task: TaskDto): void;
  /** A reorder inside the task's cell, or a new urgency (desktop drag; phone "Reorder…"). */
  onMove(task: TaskDto, to: { reorder: { beforeId: string } | { afterId: string } } | { urgency: Urgency }): void;
}
