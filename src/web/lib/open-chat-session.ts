/**
 * The one way a button outside a chat opens that chat: a tool card's "Open session", the Sessions
 * popover, a linked-chat chip, a turn chip, a task's or a schedule's "Open chat". On a desktop a
 * chat of another project opens in a floating window and the project on screen stays; everything
 * else (the same project, a phone, the Assistant) goes the way it went before. The rules are
 * `planChatOpen`.
 *
 * Notification clicks and links are not buttons on the screen the user is working in: they still
 * switch to the chat's project (`openSessionAnywhere`).
 */
import { usePanelStore } from "@/stores/panel-store";
import { useProjectStore } from "@/stores/project-store";
import { openSessionAnywhere } from "./open-session-anywhere";
import { openChatInWindow } from "./open-chat-in-window";
import { planChatOpen } from "./chat-open-plan";

export interface ChatSessionTarget {
  projectName: string;
  sessionId: string;
  providerId: string;
  /** The tab's title until the chat loads its own. */
  title?: string;
}

/**
 * Opens the chat; false when this PPM has no such project. `openHere` shows a chat of the project
 * on screen; it defaults to `openSessionAnywhere`, which focuses the tab or opens one.
 */
export async function openChatSession(
  target: ChatSessionTarget,
  openHere: () => Promise<boolean> | boolean = () => openSessionAnywhere(target.projectName, target.sessionId, target.providerId),
): Promise<boolean> {
  const plan = planChatOpen({
    projectName: target.projectName,
    activeProject: useProjectStore.getState().activeProject?.name ?? null,
    mobile: usePanelStore.getState().isMobile(),
  });
  if (plan === "here") return openHere();
  if (plan === "window") {
    const result = openChatInWindow({ ...target, title: target.title || "Chat" });
    if (result === "no-project") return false;
    if (result !== "refused") return true;
    // At the window cap the chat still opens: the screen switches to its project instead.
  }
  return openSessionAnywhere(target.projectName, target.sessionId, target.providerId);
}
