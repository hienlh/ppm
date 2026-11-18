/**
 * "Ask manager": opens the project's manager chat with the task as a chip in its composer ("Task
 * #12 · Fix login"), without sending anything — the user writes the question. It is the chip "Open
 * chat" puts in the manager chat (`openTaskChat`, which opens the chat through `openChatSession`),
 * so the next message carries the task's reference and the server writes the task's block from the
 * task store.
 */
import { toast } from "sonner";
import type { ManagerChatSummary } from "../../../shared/assistant-managers";
import type { TaskDto } from "../../../shared/ppm-tasks-api";
import { openTaskChat } from "./open-task-tab";
import { taskManagerChat } from "./task-chat-buttons";

export function managerOf(project: string, managers: readonly ManagerChatSummary[] | null): ManagerChatSummary | null {
  return managers?.find((m) => m.projectName === project) ?? null;
}

export function askManagerAboutTask(task: TaskDto, managers: readonly ManagerChatSummary[] | null): void {
  const manager = taskManagerChat(task, managers);
  if (!manager) {
    toast.info(`${task.project} has no manager chat yet`);
    return;
  }
  openTaskChat(task.project, manager.sessionId, manager.providerId, task);
}
