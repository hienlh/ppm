/**
 * "Ask manager": opens the project's manager chat and puts the task in its composer as a chip,
 * without sending anything — the user writes the question. The chip carries the task's reference,
 * title, link and next step, so the manager knows which task the question is about.
 */
import { toast } from "sonner";
import { openSessionAnywhere } from "@/lib/open-session-anywhere";
import { sendToChat } from "@/lib/send-to-chat";
import { tabSessionId } from "@/lib/tab-session-id";
import { usePanelStore } from "@/stores/panel-store";
import type { ManagerChatSummary } from "../../../shared/assistant-managers";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { taskLink } from "./open-task-tab";

export function taskChipText(task: Pick<TaskDto, "id" | "project" | "ref" | "title" | "statusName" | "nextStep">): string {
  return [
    `Task ${task.ref}: "${task.title}" (${task.statusName})`,
    task.nextStep ? `Next step: ${task.nextStep}` : null,
    `Link: ${taskLink(task)}`,
  ].filter(Boolean).join("\n");
}

export function managerOf(project: string, managers: readonly ManagerChatSummary[] | null): ManagerChatSummary | null {
  return managers?.find((m) => m.projectName === project) ?? null;
}

export async function askManagerAboutTask(task: TaskDto, managers: readonly ManagerChatSummary[] | null): Promise<void> {
  const manager = managerOf(task.project, managers);
  if (!manager) {
    toast.info(`${task.project} has no manager chat yet`);
    return;
  }
  const opened = await openSessionAnywhere(task.project, manager.sessionId, manager.providerId);
  if (!opened) {
    toast.error(`${task.project} is not a project in this PPM any more.`);
    return;
  }
  // The manager chat's own tab, wherever it opened: the "selected" chat may be another one.
  const tab = Object.values(usePanelStore.getState().panels).flatMap((p) => p.tabs).find((t) => tabSessionId(t) === manager.sessionId);
  sendToChat({ text: taskChipText(task), label: task.ref, projectName: task.project, asContext: true, targetTabId: tab?.id ?? null });
}
