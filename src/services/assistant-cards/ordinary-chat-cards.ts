import type { ChatMessageOrigin } from "../chat-control/chat-control.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";

/**
 * Which chats that are not a manager have their waiting cards put in front of the user by the PPM
 * Assistant ("Waiting on you", and Telegram when it is connected), and how such a chat is named.
 *
 * A chat waiting on a card is stopped until someone answers, and some cards give up on their own
 * (a session tool's after ten minutes): shown only in the chat, they ran out while the user was
 * away from it. So every chat of a project counts, whether or not anything watches it, except:
 *
 * - the PPM Assistant's own sessions, whose cards it shows itself;
 * - a manager chat, mirrored as a manager (`manager-signals.ts`);
 * - a chat a manager opened, directly or through its children: the manager reports what its
 *   children wait on (`needs_decision`), and a second card would ask the same thing twice;
 * - an extension's turn, which answers its cards itself or has them refused when nobody watches;
 * - a Design chat, which lives in its design's tab with the canvas: opened as a plain chat it would
 *   lose that, and it takes no forwarded words, so a mirror could neither open it nor be replied to.
 */

export interface ChatCardRef {
  projectName: string;
  projectPath: string;
  sessionId: string;
  title: string;
  providerId: string;
}

export interface OrdinaryChatDeps {
  projects(): Array<{ name: string; path: string }>;
  isAssistant(sessionId: string): boolean;
  isManager(sessionId: string): boolean;
  /** A Design chat: one with a design's slug. */
  isDesign(sessionId: string): boolean;
  /** The chat that opened this one through the session tools; null for one the user opened. */
  parentOf(sessionId: string): string | null;
  /** Who sent the message the running turn answers. */
  turnOrigin(sessionId: string): ChatMessageOrigin | undefined;
  /** The chat's name as PPM shows it; null when it has none yet. */
  title(sessionId: string): string | null;
}

/** How far up the chain of chats that opened one another a manager is looked for. */
const MAX_ANCESTORS = 8;
export const UNTITLED_CHAT = "Untitled chat";

function openedByManager(sessionId: string, deps: OrdinaryChatDeps): boolean {
  const seen = new Set<string>([sessionId]);
  let id: string | null = sessionId;
  for (let i = 0; i < MAX_ANCESTORS && id; i++) {
    id = deps.parentOf(id);
    if (!id || seen.has(id)) return false;
    if (deps.isManager(id)) return true;
    seen.add(id);
  }
  return false;
}

/** The chat, when its waiting cards are the Assistant's to show (see the header); else null. */
export function ordinaryChatFor(
  p: { sessionId: string; projectName: string; providerId: string },
  deps: OrdinaryChatDeps,
): ChatCardRef | null {
  if (!p.projectName || isAssistantProject(p.projectName)) return null;
  if (deps.isAssistant(p.sessionId) || deps.isManager(p.sessionId) || deps.isDesign(p.sessionId)) return null;
  if (deps.turnOrigin(p.sessionId) === "extension") return null;
  if (openedByManager(p.sessionId, deps)) return null;
  const project = deps.projects().find((x) => x.name === p.projectName);
  if (!project) return null;
  const title = deps.title(p.sessionId)?.replace(/\s+/g, " ").trim() || UNTITLED_CHAT;
  return { projectName: project.name, projectPath: project.path, sessionId: p.sessionId, title, providerId: p.providerId };
}
