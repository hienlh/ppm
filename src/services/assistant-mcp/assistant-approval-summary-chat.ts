import type { ApprovalFact, ApprovalSummary } from "../../shared/assistant-approval.ts";
import { unnamedChat } from "../assistant-watch/watched-chat-title.ts";
import { chatFact, exactFact, fact, providerLabel } from "./assistant-approval-summary.ts";

/**
 * The approval cards of `chat_stop`, `chat_organize` and `chat_delete`. Pure: built from the chat
 * as PPM records it and the checked arguments, never from anything the agent said about its
 * request. A new title is shown whole, since it leaves the machine in notifications.
 */

const HEADLINE_TITLE_CHARS = 80;
const LABEL_TITLE_CHARS = 60;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const nameOf = (title: string | null, sessionId: string) => cut(title || unnamedChat(sessionId), HEADLINE_TITLE_CHARS);
const at = (ms: number) => new Date(ms).toISOString();

interface ChatOnCard {
  project: string;
  sessionId: string;
  title: string | null;
  providerId: string;
}

const chatFacts = (c: ChatOnCard): ApprovalFact[] => [
  fact("Project", c.project), chatFact(c.title, c.sessionId), fact("Provider", providerLabel(c.providerId)),
];

export const STOP_WARNING = "What it already wrote stays; work in progress stops.";
export const STOP_BACKGROUND_WARNING = "Its background agents and shells stop too.";

export function chatStopSummary(input: ChatOnCard & { runningSince?: number; backgroundWork: boolean }): ApprovalSummary {
  return {
    headline: `Stop the running turn in "${nameOf(input.title, input.sessionId)}"`,
    facts: [...chatFacts(input), ...(input.runningSince !== undefined ? [fact("Running since", at(input.runningSince))] : [])],
    warning: input.backgroundWork ? `${STOP_WARNING} ${STOP_BACKGROUND_WARNING}` : STOP_WARNING,
  };
}

/** Whether the chat is pinned, or when the Assistant itself took its pin off (within a day). */
export type PinState = { pinned: true } | { pinned: false; unpinnedByAssistantAt?: number };

export const DELETE_WARNING = "The transcript and PPM's records of this chat are deleted. This cannot be undone.";

export function chatDeleteSummary(input: ChatOnCard & { pin: PinState; running: boolean }): ApprovalSummary {
  const { pin } = input;
  return {
    headline: `Delete the chat "${nameOf(input.title, input.sessionId)}"`,
    facts: [
      ...chatFacts(input),
      ...(pin.pinned ? [fact("Pinned", "Yes", "warning")] : []),
      ...(!pin.pinned && pin.unpinnedByAssistantAt !== undefined
        ? [fact("Pinned", `Until ${at(pin.unpinnedByAssistantAt)} (unpinned by the Assistant)`, "warning")] : []),
      ...(input.running ? [fact("Running now", "It is stopped first", "warning")] : []),
    ],
    warning: DELETE_WARNING,
  };
}

/** One chat's change, already reduced to what differs from what PPM records. */
export interface OrganizeChange {
  title?: string;
  pinned?: boolean;
  /** A tag's name, or null to take the tag off. */
  tag?: string | null;
  read?: boolean;
}

export function describeOrganizeChange(change: OrganizeChange): string {
  const parts: string[] = [];
  if (change.title !== undefined) parts.push(`rename → «${change.title}»`);
  if (change.pinned !== undefined) parts.push(change.pinned ? "pin" : "unpin");
  if (change.tag !== undefined) parts.push(change.tag === null ? "remove the tag" : `tag ${change.tag}`);
  if (change.read !== undefined) parts.push(change.read ? "mark read" : "mark unread");
  return parts.join(", ");
}

export function chatOrganizeSummary(input: {
  project: string;
  entries: Array<{ sessionId: string; title: string | null; change: OrganizeChange }>;
}): ApprovalSummary {
  const n = input.entries.length;
  return {
    headline: `Change ${n} chat${n === 1 ? "" : "s"} in "${input.project}"`,
    facts: input.entries.map((e) => exactFact(
      cut(e.title || unnamedChat(e.sessionId), LABEL_TITLE_CHARS),
      `${describeOrganizeChange(e.change)} (${e.sessionId})`,
      e.change.pinned === false ? "warning" : undefined,
    )),
  };
}
