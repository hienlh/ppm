/**
 * The session's changes, as the chat's changes bar holds them, for the parts of the transcript
 * that answer them too: each turn's change tray keeps, reverts and reopens the blocks its edits
 * wrote, and has to see the same list the bar does — one request for the whole chat.
 */
import { createContext, useContext } from "react";
import type { SessionFileChange } from "../../../shared/session-file-changes";

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
