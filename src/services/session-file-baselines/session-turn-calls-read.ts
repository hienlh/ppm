import { readSessionHistory } from "../chat-history-read.service.ts";
import { DEFAULT_TURN_LIMIT, summarizeTurns, type SessionTurnCalls } from "./session-turn-calls.ts";

/**
 * A session's newest turns with their calls, read as the chat tab reads its history (the same
 * cached parse, stamped with the server's turn numbers). The caller has already proven the
 * session is the project's.
 */
export async function sessionTurnCalls(p: {
  providerId: string;
  sessionId: string;
  projectPath: string;
  limit?: number;
}): Promise<SessionTurnCalls> {
  const page = await readSessionHistory(p.providerId, p.sessionId, {}, p.projectPath);
  return summarizeTurns(page.messages, p.limit ?? DEFAULT_TURN_LIMIT, page.start === 0);
}
