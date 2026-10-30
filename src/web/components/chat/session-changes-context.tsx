/**
 * The session's changes, as the chat's changes bar holds them, for the parts of the transcript
 * that answer them too: each turn's change tray keeps, reverts and reopens the blocks its edits
 * wrote, and has to see the same list the bar does — one request for the whole chat.
 */
import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import type { SessionFileChange } from "../../../shared/session-file-changes";
import { openSessionReview } from "@/lib/session-file-changes-client";

export interface SessionChangesValue {
  projectName: string;
  sessionId: string;
  files: SessionFileChange[];
  /** Ask the server again, after an answer changed what it holds. */
  refresh: () => void;
  /** Open the session's Review tab, on `path` when given. */
  openReview: (path?: string) => void;
}

export const SessionChangesContext = createContext<SessionChangesValue | null>(null);

export const useSessionChanges = () => useContext(SessionChangesContext);

/**
 * The value the chat provides, and the Review opener its changes bar uses.
 *
 * Every turn's action bar reads this context, so the value has to stay the same object while
 * the agent streams: `paths` is a new array on every flush, which is why it is read only when
 * the Review tab opens.
 */
export function useSessionChangesValue({ projectName, sessionId, title, providerId, changes }: {
  projectName: string;
  sessionId: string | null;
  title?: string;
  providerId: string;
  changes: { files: SessionFileChange[]; paths: string[]; refresh: () => void };
}): { value: SessionChangesValue | null; openReview: (path?: string) => void } {
  const pathsRef = useRef(changes.paths);
  pathsRef.current = changes.paths;
  const openReview = useCallback((path?: string) => {
    if (!sessionId) return;
    openSessionReview({ projectName, sessionId, title, providerId, paths: pathsRef.current, selectPath: path });
  }, [projectName, sessionId, title, providerId]);
  const { files, refresh } = changes;
  const value = useMemo((): SessionChangesValue | null => (
    projectName && sessionId ? { projectName, sessionId, files, refresh, openReview } : null
  ), [projectName, sessionId, files, refresh, openReview]);
  return { value, openReview };
}
