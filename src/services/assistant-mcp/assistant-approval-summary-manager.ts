import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import { MANAGER_ASSIGN_BYPASS, MANAGER_ASSIGN_CONSEQUENCE, MANAGER_TOOLS_NEXT_START } from "../../shared/assistant-managers.ts";
import { unnamedChat } from "../assistant-watch/watched-chat-title.ts";
import { chatFact, exactFact, fact, modeLabel, providerLabel } from "./assistant-approval-summary.ts";

/**
 * The approval cards of `manager_assign` and `manager_unassign`. Pure: built from the chats as PPM
 * records them, never from anything the agent said. The consequence is worded as the "Set as
 * manager chat" dialog words it, so the card and the screen promise the same thing.
 */

const HEADLINE_TITLE_CHARS = 80;
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const nameOf = (title: string | null, sessionId: string) => cut(title || unnamedChat(sessionId), HEADLINE_TITLE_CHARS);

export const MANAGER_RULES_NOTE = "If the project has no manager rules yet, PPM writes them to .ppm/manager.md (and .ppm/.gitignore) "
  + "in its folder; a file already there is held for you to review.";
export const MANAGER_REPLACED_NOTE = "The chat it replaces keeps its history; you then message it only with a card.";
export const MANAGER_UNASSIGN_NOTE = "The chat itself is kept, with its history and mode. PPM Assistant no longer messages it "
  + "without asking, and .ppm/manager.md stays in the folder.";

interface ChatRef { sessionId: string; title: string | null }

export interface ManagerAssignApproval {
  project: string;
  chat: ChatRef & { providerId: string; lastActivity: number | null };
  /** The mode the chat runs in; assigning leaves it as it is. */
  permissionMode: string;
  /** The project's manager chat that stops being it; null when the project has none. */
  replaces: ChatRef | null;
}

export function managerAssignSummary(input: ManagerAssignApproval): ApprovalSummary {
  const { chat, replaces } = input;
  const bypass = input.permissionMode === "bypassPermissions";
  const facts: ApprovalFact[] = [
    exactFact("Project", input.project),
    chatFact(chat.title, chat.sessionId),
    fact("Provider", providerLabel(chat.providerId)),
    fact("Last activity", chat.lastActivity === null ? "Unknown" : new Date(chat.lastActivity).toISOString()),
    fact("Mode (unchanged)", modeLabel(input.permissionMode), bypass ? "warning" : undefined),
    ...(replaces ? [{ ...chatFact(replaces.title, replaces.sessionId), label: "Stops being the manager", tone: "warning" as const }] : []),
  ];
  return {
    headline: replaces
      ? `Make "${nameOf(chat.title, chat.sessionId)}" the manager chat of "${input.project}", replacing "${nameOf(replaces.title, replaces.sessionId)}"`
      : `Make "${nameOf(chat.title, chat.sessionId)}" the manager chat of "${input.project}"`,
    facts,
    warning: [
      MANAGER_ASSIGN_CONSEQUENCE, ...(bypass ? [MANAGER_ASSIGN_BYPASS] : []), MANAGER_RULES_NOTE, MANAGER_TOOLS_NEXT_START,
      ...(replaces ? [MANAGER_REPLACED_NOTE] : []),
    ].join(" "),
  };
}

export function managerUnassignSummary(input: { project: string; chat: ChatRef }): ApprovalSummary {
  return {
    headline: `Stop "${nameOf(input.chat.title, input.chat.sessionId)}" being the manager chat of "${input.project}"`,
    facts: [exactFact("Project", input.project), chatFact(input.chat.title, input.chat.sessionId)],
    warning: MANAGER_UNASSIGN_NOTE,
  };
}
