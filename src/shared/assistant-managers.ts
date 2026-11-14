/**
 * Manager chats and the main Assistant session, as the server and the browser both see them.
 *
 * A project's **manager chat** is the one chat PPM Assistant talks to about that project: at most
 * one per project, one project per chat, a Claude chat of that project that is neither a design
 * nor an Assistant session. The **main** Assistant session is the one Telegram follows.
 */
import { isAssistantProject } from "./assistant-project.ts";
import { MAX_COLLAB_TITLE_CHARS } from "./session-collab.ts";

export const MANAGERS_CHANGED_EVENT = "assistant:managers_changed";
export const MAIN_SESSION_CHANGED_EVENT = "assistant:main_session_changed";

export const MANAGER_TELEGRAM_DETAILS = ["full", "title"] as const;
export type ManagerTelegramDetail = (typeof MANAGER_TELEGRAM_DETAILS)[number];

/** The only provider a manager chat or the main session may run on for now. */
export const MANAGER_PROVIDER_ID = "claude";
export const MANAGER_CLAUDE_ONLY = "Manager chats run on Claude for now";

/**
 * The title a new manager chat gets when nobody names it: "QL" ("quản lý", manager) and the
 * project, so several manager chats open side by side say which project each one runs.
 */
export function defaultManagerTitle(projectName: string): string {
  // Cut by character, not UTF-16 unit, so an emoji at the limit is never split in half; within
  // the session tools' title limit, so both doors that create a manager chat name it alike.
  // Spaces and control characters collapsed as the session tools collapse a given title.
  // eslint-disable-next-line no-control-regex -- control characters are what this pattern is for
  const name = projectName.replace(/[\x00-\x1f\x7f\s]+/g, " ").trim();
  return Array.from(`QL ${name}`).slice(0, MAX_COLLAB_TITLE_CHARS).join("").trim();
}

/** What every surface listing a project's manager shows. */
export interface ManagerChatSummary {
  projectName: string;
  projectPath: string;
  sessionId: string;
  providerId: string;
  /** Null when neither PPM nor the provider has a title for the chat yet. */
  title: string | null;
  /** The chat's phase in this server: `idle` when it is not open. */
  phase: string;
  permissionMode: string;
  digest: boolean;
  telegramDetail: ManagerTelegramDetail;
  /** Cards waiting on the user for this project. */
  waiting: number;
  rulesPending: boolean;
  /**
   * The chat's live stream started before it was made the manager, so its manager tools arrive
   * the next time it starts. Absent from a server that predates the field.
   */
  toolsPending?: boolean;
}

export interface MainSessionRef {
  providerId: typeof MANAGER_PROVIDER_ID;
  sessionId: string;
}

/** What `GET /managers/:project/check` answers before the assign dialog opens. */
export interface ManagerAssignCheck {
  permissionMode: string;
  /** The project's current manager, which assigning replaces; null when it has none. */
  replaces: { sessionId: string; title: string | null } | null;
  /** True when the chat already is the project's manager. */
  already: boolean;
}

/**
 * Whether a session row may be offered "Set as manager chat", from what the list knows of it.
 * The server checks again on assign (the session's stored project, provider and flags).
 */
export function canOfferManagerRole(
  session: { providerId?: string; designSlug?: string | null },
  projectName: string,
): boolean {
  return session.providerId === MANAGER_PROVIDER_ID && !session.designSlug && !isAssistantProject(projectName);
}

/** The consequence the assign dialog states, and the line added for a chat in bypass mode. */
export const MANAGER_ASSIGN_CONSEQUENCE = "After this, PPM Assistant can message this chat without asking, also while you are away.";
export const MANAGER_ASSIGN_BYPASS = "This chat runs without approval prompts.";
export const MANAGER_TOOLS_NEXT_START = "Manager tools arrive the next time this chat starts.";
