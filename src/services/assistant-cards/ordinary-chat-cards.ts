import type { ChatMessageOrigin } from "../chat-control/chat-control.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import { projectKey } from "../project-name-for-path.ts";

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
 * - an extension's turn, which answers its cards itself or has them refused when nobody watches.
 *
 * A Design chat is mirrored as a link only (`design`): it lives in its design's tab with the canvas,
 * where opened as a plain chat it would lose that, and it takes no forwarded words. Its card says
 * the chat waits and opens the design; it is answered there.
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
  /** A Design chat: the design it belongs to. Its cards are links to the design, never answered off it. */
  design?: { slug: string };
}

export interface OrdinaryChatDeps {
  projects(): Array<{ name: string; path: string }>;
  isAssistant(sessionId: string): boolean;
  isManager(sessionId: string): boolean;
  /** A Design chat's design slug; null for any other chat. */
  designSlug(sessionId: string): string | null;
  /** Who sent the message the running turn answers. */
  turnOrigin(sessionId: string): ChatMessageOrigin | undefined;
  /** The chat's name as PPM shows it; null when it has none yet. */
  title(sessionId: string): string | null;
}

export const UNTITLED_CHAT = "Untitled chat";

/** The chat, when its waiting cards are the Assistant's to show (see the header); else null. */
export function ordinaryChatFor(
  p: { sessionId: string; projectName: string; providerId: string; projectPath?: string },
  deps: OrdinaryChatDeps,
): ChatCardRef | null {
  if (!p.projectName || isAssistantProject(p.projectName)) return null;
  if (deps.isAssistant(p.sessionId) || deps.isManager(p.sessionId)) return null;
  if (deps.turnOrigin(p.sessionId) === "extension") return null;
  const project = findProject(deps.projects(), p);
  if (!project) return null;
  const title = deps.title(p.sessionId)?.replace(/\s+/g, " ").trim() || UNTITLED_CHAT;
  const slug = deps.designSlug(p.sessionId);
  return {
    projectName: project.name, projectPath: project.path, sessionId: p.sessionId, title, providerId: p.providerId,
    ...(slug ? { design: { slug } } : {}),
  };
}

/**
 * The chat's project: by its folder when the chat knows it (a name is spelled however the chat was
 * opened, and on Windows two spellings of one folder are one project), else by its name.
 */
function findProject(projects: Array<{ name: string; path: string }>, p: { projectName: string; projectPath?: string }) {
  if (p.projectPath) {
    const key = projectKey(p.projectPath);
    const byPath = projects.find((x) => projectKey(x.path) === key);
    if (byPath) return byPath;
  }
  return projects.find((x) => x.name === p.projectName) ?? null;
}
