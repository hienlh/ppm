/**
 * Where a chat opens when something outside its tab asks for it (a tool card's "Open session", a
 * linked-chat chip, a turn chip, a task's or a schedule's "Open chat"). Pure, so it is testable
 * without the stores; `open-chat-session.ts` carries it out.
 *
 *  - `assistant`: a PPM Assistant session belongs to no project and opens in the Assistant.
 *  - `here`: a chat of the project on screen opens as a tab, as it always has.
 *  - `window`: a chat of another project opens in a floating window, and the screen stays on the
 *    project the user was working in.
 *  - `switch`: the screen switches to the chat's project. That is the phone's way (no window
 *    layer below `md`), and the way when no project is on screen at all.
 */
import { isAssistantProject } from "../../shared/assistant-project";

export type ChatOpenPlan = "assistant" | "here" | "window" | "switch";

export interface ChatOpenInput {
  /** The project the chat belongs to. */
  projectName: string;
  /** The project on screen, if any. */
  activeProject: string | null;
  /** Below `md`, where floating windows do not exist. */
  mobile: boolean;
}

export function planChatOpen({ projectName, activeProject, mobile }: ChatOpenInput): ChatOpenPlan {
  if (isAssistantProject(projectName)) return "assistant";
  if (projectName === activeProject) return "here";
  if (mobile || !activeProject) return "switch";
  return "window";
}
