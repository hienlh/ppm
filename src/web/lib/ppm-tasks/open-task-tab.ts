/**
 * Opening tasks and their chats from the task views.
 *
 * `openTaskTab` shows a task in the main area: a plain selection opens a *preview* tab (replaced
 * by the next selection), `keep` opens or turns it into a kept tab. `keepTaskTab` keeps the tab of
 * a task the user just edited. `openTaskChat` opens a task's working chat in whatever project it
 * belongs to, and `copyTaskLink` puts the task's address on the clipboard.
 */
import { toast } from "sonner";
import { usePanelStore } from "@/stores/panel-store";
import { openSessionAnywhere } from "@/lib/open-session-anywhere";
import type { TaskDto } from "../../../shared/ppm-tasks-api";

export interface TaskTabTarget {
  id: string;
  project: string;
  title: string;
}

export function openTaskTab(task: TaskTabTarget, opts: { keep?: boolean } = {}): string {
  return usePanelStore.getState().openTab({
    type: "task",
    title: task.title,
    projectId: usePanelStore.getState().currentProject ?? task.project,
    closable: true,
    metadata: { taskId: task.id, projectName: task.project, ...(opts.keep ? {} : { preview: true }) },
  });
}

export { keepTaskTab } from "./keep-task-tab";

/** Keeps the title of an open task tab in step with the task. */
export function syncTaskTabTitle(tabId: string | undefined, title: string): void {
  if (!tabId) return;
  const store = usePanelStore.getState();
  const tab = Object.values(store.panels).flatMap((p) => p.tabs).find((t) => t.id === tabId);
  if (tab && tab.title !== title) store.updateTab(tabId, { title });
}

/** Opens a chat of the task's project by id (the working chat, a linked chat). */
export function openTaskChat(project: string, sessionId: string, providerId?: string | null): void {
  void openSessionAnywhere(project, sessionId, providerId || "claude").then((ok) => {
    if (!ok) toast.error(`${project} is not a project in this PPM any more.`);
  });
}

/** The working chat's provider, when the task names one. */
export function workingProvider(task: Pick<TaskDto, "workingSession">): string | null {
  const w = task.workingSession;
  return w.kind === "start_chat" ? null : w.session.providerId ?? null;
}

/** The address of a task, as the URL bar shows it once the task tab is open. */
export function taskLink(task: Pick<TaskDto, "id" | "project">): string {
  return `${window.location.origin}/project/${encodeURIComponent(task.project)}/task/${task.id}`;
}

export async function copyTaskLink(task: Pick<TaskDto, "id" | "project" | "ref">): Promise<void> {
  try {
    await navigator.clipboard.writeText(taskLink(task));
    toast.success(`Link to ${task.ref} copied`);
  } catch {
    toast.error("Could not copy the link");
  }
}
