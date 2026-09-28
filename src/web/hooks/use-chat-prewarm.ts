import { useCallback, useEffect, useRef } from "react";
import { api, projectUrl } from "@/lib/api-client";
import type { TurnSettings } from "@/hooks/use-chat";

/** How long the picks must hold still before asking, so a tab passed through asks nothing. */
const SETTLE_MS = 300;
/** Asked again at most this often while the user types; the server keeps a process 5 min. */
const REASK_MS = 60_000;

export interface ChatPrewarmInput {
  /** A new chat is open and on screen: no session yet, not a design tab. */
  enabled: boolean;
  projectName: string;
  providerId: string;
  permissionMode?: string;
  /** The account the tab claimed, which the session will be created on. */
  accountId?: string;
  /** What the first message will carry — `useChat().turnSettings()`. */
  picks: TurnSettings;
}

/**
 * Has the server start the Claude process a new chat's first message will run on while
 * that message is still being written, so sending it does not wait ~1.4 s for the CLI to
 * boot (`src/providers/claude-warm-spare.ts` has the numbers).
 *
 * Asks when the composer opens and whenever a pick changes — the process only serves a
 * message that carries the picks it was started with. Returns `touch`, for the composer to
 * call as the user types: it asks again at most once a minute, which keeps the process
 * alive while someone is writing and lets it go when they walk away.
 */
export function useChatPrewarm(input: ChatPrewarmInput): () => void {
  const { enabled, projectName, providerId, permissionMode, accountId, picks } = input;
  const lastAskAt = useRef(0);
  const ask = useRef(() => {});
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  ask.current = () => {
    lastAskAt.current = Date.now();
    void api.post(`${projectUrl(projectName)}/chat/prewarm`, { providerId, permissionMode, accountId, ...picks }).catch(() => {});
  };

  const key = JSON.stringify([projectName, providerId, permissionMode ?? null, accountId ?? null, picks]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => ask.current(), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [enabled, key]);

  return useCallback(() => {
    if (enabledRef.current && Date.now() - lastAskAt.current >= REASK_MS) ask.current();
  }, []);
}
