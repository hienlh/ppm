/**
 * The changes bar's data: every file this chat session has changed, kept current while the
 * agent works.
 *
 * The server holds the answer (each file's state before the session's first write, against
 * the disk now); the transcript only says *when* to ask again. That is whenever a file write
 * or a shell command finishes, a new file is named, or a turn starts or ends — not on every
 * streamed token, which is what `messages` changes on.
 *
 * Marking files reviewed updates the list at once and asks again once the marks are saved. No
 * list is fetched while they are on their way: one answered before they landed would bring
 * the rows back for a moment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionFileWrites } from "@/lib/aggregate-turn-file-changes";
import { withReviewed } from "@/lib/session-file-changes";
import {
  SESSION_REVIEW_MARKS_EVENT,
  announceSessionChanges,
  fetchSessionFileChanges,
  setSessionFilesReviewed,
} from "@/lib/session-file-changes-client";
import type { ChatMessage } from "../../types/chat";
import type { SessionFileChange } from "../../shared/session-file-changes";

/** Folds a burst of edits into one request while still reading as live. */
const REFETCH_DELAY_MS = 400;

export function useSessionFileChanges({ projectName, sessionId, messages, isStreaming }: {
  projectName: string;
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
}): {
  files: SessionFileChange[];
  paths: string[];
  refresh: () => void;
  setReviewed: (files: SessionFileChange[], reviewed: boolean) => void;
} {
  const { paths, settled } = useMemo(() => sessionFileWrites(messages), [messages]);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;
  const pathsKey = paths.join("\n");

  const key = projectName && sessionId ? `${projectName}\0${sessionId}` : "";
  const [state, setState] = useState<{ key: string; files: SessionFileChange[] }>({ key: "", files: [] });
  const [nonce, setNonce] = useState(0);
  const marking = useRef(0);

  useEffect(() => {
    if (!key || !sessionId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Saving the marks asks again.
      if (marking.current > 0) return;
      const asked = pathsRef.current;
      const askedAt = performance.now();
      fetchSessionFileChanges(projectName, sessionId, asked, controller.signal)
        .then((files) => {
          setState({ key, files });
          announceSessionChanges({ projectName, sessionId, files, paths: asked, askedAt });
        })
        // Keep the last list: a failed refresh says nothing about what changed.
        .catch(() => {});
    }, REFETCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, projectName, sessionId, pathsKey, settled, isStreaming, nonce]);

  // Marks saved from a Review tab change what this list hides.
  useEffect(() => {
    const onMarks = (e: Event) => {
      const detail = (e as CustomEvent<{ projectName: string; sessionId: string }>).detail;
      if (detail.projectName === projectName && detail.sessionId === sessionId) setNonce((n) => n + 1);
    };
    window.addEventListener(SESSION_REVIEW_MARKS_EVENT, onMarks);
    return () => window.removeEventListener(SESSION_REVIEW_MARKS_EVENT, onMarks);
  }, [projectName, sessionId]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const setReviewed = useCallback((targets: SessionFileChange[], reviewed: boolean) => {
    if (!key || !sessionId || targets.length === 0) return;
    const paths = new Set(targets.map((f) => f.path));
    marking.current++;
    setState((s) => (s.key === key ? { key, files: withReviewed(s.files, paths, reviewed) } : s));
    setSessionFilesReviewed(projectName, sessionId, targets, reviewed)
      // The list asked for next says what was saved, and brings back a row that was not.
      .catch(() => {})
      .finally(() => {
        marking.current--;
        setNonce((n) => n + 1);
      });
  }, [key, projectName, sessionId]);

  // A list fetched for the previous session is never shown under this one.
  return { files: state.key === key ? state.files : [], paths, refresh, setReviewed };
}
