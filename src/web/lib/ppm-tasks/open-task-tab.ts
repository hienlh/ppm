/**
 * Opening tasks and their chats from the task views.
 *
 * Callers open a task with `openTask` (`open-task.ts`), which picks a window, a sheet or this tab.
 * `openTaskTab` shows a task in the main area: a plain selection opens a *preview* tab (replaced
 * by the next selection), `keep` opens or turns it into a kept tab. `keepTaskTab` keeps the tab of
 * a task the user just edited. `openTaskChat` opens a task's working chat in whatever project it
 * belongs to, and `copyTaskLink` puts the task's address on the clipboard.
 */
import { toast } from "sonner";
import { usePanelStore } from "@/stores/panel-store";
import type { Tab } from "@/stores/tab-store";
import { openChatSession } from "@/lib/open-chat-session";
import { managerChatsNow } from "@/hooks/use-manager-chats";
import { attachTaskChip, chipGoesToChat, taskChipOf } from "./composer-task-chip";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { taskCode } from "../../../shared/ppm-tasks-refs";

export interface TaskTabTarget {
  id: string;
  project: string;
  title: string;
  /** The task's number, when the caller has it: the tab then reads "#12 Fix login" at once. */
  number?: number;
}

/**
 * A task tab's name: its code, then its title ("#12 Fix login"; "ppm/12 Fix login" in a panel of
 * another project). The code comes first, so the tab's ellipsis only ever cuts the title.
 */
export function taskTabTitle(task: { number: number; project: string; title: string }, tabProject: string | null): string {
  return `${taskCode(task, tabProject)} ${task.title}`;
}

/** The tab that shows a task, as a preview unless `keep`. A window holds the same tab. */
export function taskTabDef(task: TaskTabTarget, opts: { keep?: boolean } = {}): Omit<Tab, "id"> {
  const projectId = usePanelStore.getState().currentProject ?? task.project;
  return {
    type: "task",
    title: task.number !== undefined ? taskTabTitle({ number: task.number, project: task.project, title: task.title }, projectId) : task.title,
    projectId,
    closable: true,
    metadata: { taskId: task.id, projectName: task.project, ...(opts.keep ? {} : { preview: true }) },
  };
}

/**
 * Opens a task as a tab in the grid. Most callers want `openTask` (a window on a desktop, a sheet
 * on a phone); this is for a tab on purpose: the deep link, "Open as tab", "Full screen".
 */
export function openTaskTab(task: TaskTabTarget, opts: { keep?: boolean } = {}): string {
  return usePanelStore.getState().openTab(taskTabDef(task, opts));
}

export { keepTaskTab } from "./keep-task-tab";

/** Keeps the name of an open task tab in step with the task's code and title. */
export function syncTaskTabTitle(tabId: string | undefined, task: { number: number; project: string; title: string }): void {
  if (!tabId) return;
  const store = usePanelStore.getState();
  const tab = Object.values(store.panels).flatMap((p) => p.tabs).find((t) => t.id === tabId);
  if (!tab) return;
  const title = taskTabTitle(task, tab.projectId ?? null);
  if (tab.title !== title) store.updateTab(tabId, { title });
}

/**
 * Opens a chat of the task's project by id (the working chat, a linked chat). Given `task`, and
 * when the chat is the project's manager chat, its composer also shows the task as a chip, so the
 * next message says which task it is about: the manager works on many tasks at once. A chat the
 * task was handed off to opens with no chip (`chipGoesToChat`).
 */
export function openTaskChat(
  project: string, sessionId: string, providerId?: string | null,
  task?: Pick<TaskDto, "id" | "number" | "ref" | "title" | "project" | "workingSession">,
): void {
  void openChatSession({ projectName: project, sessionId, providerId: providerId || "claude" }).then(async (ok) => {
    if (!ok) toast.error(`${project} is not a project in this PPM any more.`);
    else if (task && chipGoesToChat(task, sessionId, await managerChatsNow())) void attachTaskChip(sessionId, taskChipOf(task));
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
