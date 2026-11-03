/**
 * Which turn a user message started, for Copy turn link. In this order, and never guessed:
 *
 * 1. `message.turnId`, which every history path stamps for both providers.
 * 2. The binding `turn_started` made for the id this browser sent the message under. A steered
 *    message is bound to the running turn it joined; a queued one only once its own turn starts.
 * 3. The session's turn index, asked by the message's record uuid.
 *
 * A message with none of these yet (just sent, its turn not started) waits for 1 or 2 to arrive
 * rather than taking the newest turn, which for a queued message would be someone else's.
 */
import type { ChatMessage } from "../../types/chat";
import { api } from "./api-client";
import { boundTurnId } from "@/stores/turn-binding-store";
import { TURN_ID_RE } from "../../shared/session-turn-ids";

export interface TurnIdContext {
  projectName: string;
  sessionId: string;
  providerId: string;
}

/** How long a just-sent message may wait for its turn to start before the copy gives up. */
export const TURN_ID_WAIT_MS = 120_000;
const POLL_MS = 200;

/** Steps 1 and 2: the id when it is already known, without asking anyone. */
export function knownTurnId(message: Pick<ChatMessage, "turnId" | "clientId">): string | undefined {
  return message.turnId ?? boundTurnId(message.clientId);
}

/** Step 3: the session's index, by the message's record uuid. Null when it does not know. */
async function resolveByUuid(message: Pick<ChatMessage, "sdkUuid">, ctx: TurnIdContext): Promise<string | null> {
  if (!message.sdkUuid) return null;
  const path = `/api/project/${encodeURIComponent(ctx.projectName)}/chat/sessions/${encodeURIComponent(ctx.sessionId)}/turns`
    + `?providerId=${encodeURIComponent(ctx.providerId)}&resolve=${encodeURIComponent(message.sdkUuid)}`;
  try {
    const result = await api.get<{ resolved?: { turnId?: unknown } | null }>(path);
    const id = result?.resolved?.turnId;
    return typeof id === "string" && TURN_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The turn of the message `current()` returns, read again on every check: the message object is
 * replaced when history reloads and stamps it. Null when nothing names it within `waitMs`, or
 * when `signal` aborts.
 */
export async function resolveTurnId(
  current: () => Pick<ChatMessage, "turnId" | "clientId" | "sdkUuid">,
  ctx: TurnIdContext,
  opts: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<string | null> {
  const known = knownTurnId(current());
  if (known) return known;
  const resolved = await resolveByUuid(current(), ctx);
  if (resolved) return resolved;
  const deadline = Date.now() + (opts.waitMs ?? TURN_ID_WAIT_MS);
  while (Date.now() < deadline && !opts.signal?.aborted) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const id = knownTurnId(current());
    if (id) return id;
  }
  return null;
}
