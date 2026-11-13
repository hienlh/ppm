/**
 * The PPM Assistant's list of manager chats, as one shared-context entry on its turns: which chat
 * manages which project, by session id and title. Only fields that rarely change, so the entry is
 * re-sent (the shared-context path compares it with what the model last got) only when a manager
 * is assigned, unassigned or renamed. Titles are quoted and cleaned: an AI may have written them.
 */
import { cleanEventText } from "../assistant-watch/watch-event-text.ts";

export interface ManagerListing {
  projectName: string;
  sessionId: string;
  title: string | null;
}

const MAX_TITLE = 120;
const MAX_LISTED = 50;

export function assistantManagersContextEntry(managers: readonly ManagerListing[]): string {
  const head = "Manager chats (written by PPM): each project's manager chat, which you message with send_to_session and "
    + "no card. Every other chat needs the user's OK on a card.";
  if (managers.length === 0) {
    return `${head}\nNo project has a manager chat yet. manager_assign makes a chat the user already has the manager; `
      + "create_session with manager: true creates a new one. Both ask the user first.";
  }
  const sorted = [...managers].sort((a, b) => a.projectName.localeCompare(b.projectName));
  const lines = sorted.slice(0, MAX_LISTED).map((m) => {
    const title = cleanEventText(m.title ?? "", MAX_TITLE) || "Untitled";
    return `- ${JSON.stringify(cleanEventText(m.projectName, 100))} → session ${cleanEventText(m.sessionId, 80)}, ${JSON.stringify(title)}`;
  });
  if (sorted.length > MAX_LISTED) lines.push(`- …and ${sorted.length - MAX_LISTED} more (session_status lists them all).`);
  return `${head}\n${lines.join("\n")}`;
}
