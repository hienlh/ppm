import type { ChatMessageOrigin } from "../chat-control/chat-control.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";

/**
 * Which chats that are not a manager have their waiting cards put in front of the user by the PPM
 * Assistant ("Waiting on you", and Telegram when it is connected), and how such a chat is named.
 *
 * A chat waiting on a card is stopped until someone answers, and some cards give up on their own
 * (a session tool's after an hour): shown only in the chat, they ran out while the user was away
 * from it. So every chat of a project counts, whether or not anything watches it, and whoever
 * opened it — the user, another chat, or a manager chat at any depth — except:
 *
 * - the PPM Assistant's own sessions, whose cards it shows itself;
 * - a manager chat, mirrored as a manager (`manager-signals.ts`);
 * - an extension's turn, which answers its cards itself or has them refused when nobody watches;
 * - a Design chat, which lives in its design's tab with the canvas: opened as a plain chat it would
 *   lose that, and it takes no forwarded words, so a mirror could neither open it nor be replied to.
 *
 * A chat a manager opened is mirrored too: a manager only learns of its child's card when it next
 * looks, often after the card ran out, and the user had to go looking for it. The manager's own
 * report about the same card is folded into the mirror (`report_to_assistant` with `chat`, see
 * `manager-report-tool.ts`), so the user still sees one card, the one they can answer.
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
  /** Who sent the message the running turn answers. */
  turnOrigin(sessionId: string): ChatMessageOrigin | undefined;
  /** The chat's name as PPM shows it; null when it has none yet. */
  title(sessionId: string): string | null;
}

export const UNTITLED_CHAT = "Untitled chat";

/** The chat, when its waiting cards are the Assistant's to show (see the header); else null. */
export function ordinaryChatFor(
  p: { sessionId: string; projectName: string; providerId: string },
  deps: OrdinaryChatDeps,
): ChatCardRef | null {
  if (!p.projectName || isAssistantProject(p.projectName)) return null;
  if (deps.isAssistant(p.sessionId) || deps.isManager(p.sessionId) || deps.isDesign(p.sessionId)) return null;
  if (deps.turnOrigin(p.sessionId) === "extension") return null;
  const project = deps.projects().find((x) => x.name === p.projectName);
  if (!project) return null;
  const title = deps.title(p.sessionId)?.replace(/\s+/g, " ").trim() || UNTITLED_CHAT;
  return { projectName: project.name, projectPath: project.path, sessionId: p.sessionId, title, providerId: p.providerId };
}
