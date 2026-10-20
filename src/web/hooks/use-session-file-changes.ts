/**
 * The changes bar's data: every file this chat session has changed.
 *
 * The server holds the answer (each file's state before the session's first write, against
 * the disk now), and working it out is expensive: a session that touched a few thousand files
 * kept the server busy for minutes per request. So the list is asked for only when the user
 * opens it — the changes bar, a turn's change pill, or an answer given from either — never
 * because the transcript moved. Until then the bar shows a count: the files the transcript
 * names, or the server's count of the files it kept a "before" for (a directory listing, asked
 * again when a turn ends) — shell commands write files no tool call names.
 *
 * Once asked for, the list is kept current without asking again: the server keeps it too, and
 * pushes the rows of the files the agent has just changed (`session:file-changes` on
 * `/ws/global`), which are put in place. A push sent while the socket was down is lost, and a
 * restarted server keeps no list to push from, so a list already asked for is asked for again
 * whenever the socket connects — a few `stat`s a file, unless the server has to start over.
 *
 * Marking files reviewed updates the list at once and asks again once the marks are saved. No
 * list is fetched while they are on their way: one answered before they landed would bring
 * the rows back for a moment. A pushed row that lands while a list or the marks are on their
 * way is set aside the same way, since it may be older than what they bring, and the list is
 * asked for again once they are in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionFileWrites } from "@/lib/aggregate-turn-file-changes";
import { withPushedChanges, withReviewed } from "@/lib/session-file-changes";
import { onGlobalReady } from "@/lib/global-ws-channel";
import {
  SESSION_REVIEW_MARKS_EVENT,
  announceSessionChanges,
  fetchSessionChangeCount,
  fetchSessionFileChanges,
  setSessionFilesReviewed,
} from "@/lib/session-file-changes-client";
import type { ChatMessage } from "../../types/chat";
import { SESSION_FILE_CHANGES_PUSH, type SessionFileChange, type SessionFileChangesPushEvent } from "../../shared/session-file-changes";

export function useSessionFileChanges({ projectName, sessionId, messages, isStreaming }: {
  projectName: string;
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
}): {
  files: SessionFileChange[];
  paths: string[];
  /** How many files the bar can say changed before the list is asked for. */
  unloadedCount: number;
  /** Whether the server's list has been asked for, and answered, for this session. */
  loaded: boolean;
  loading: boolean;
  refresh: () => void;
  setReviewed: (files: SessionFileChange[], reviewed: boolean) => void;
} {
  const { paths } = useMemo(() => sessionFileWrites(messages), [messages]);
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  const key = projectName && sessionId ? `${projectName}\0${sessionId}` : "";
  const [state, setState] = useState<{ key: string; files: SessionFileChange[] }>({ key: "", files: [] });
  // What a pushed row is put into: written with every list taken, ahead of the render.
  const stateRef = useRef(state);
  const put = useCallback((next: { key: string; files: SessionFileChange[] }) => {
    stateRef.current = next;
    setState(next);
  }, []);
  // Each ask names the session it was made for, so switching chats never fetches on its own.
  const [ask, setAsk] = useState<{ key: string; n: number }>({ key: "", n: 0 });
  const [loadingKey, setLoadingKey] = useState("");
  const [count, setCount] = useState<{ key: string; n: number }>({ key: "", n: 0 });
  const marking = useRef(0);
  const runRef = useRef(0);
  /** A list is on its way: a row pushed meanwhile may be older than what it brings. */
  const fetching = useRef(false);
  /** A pushed row was set aside while a list or the marks were on their way. */
  const askAgain = useRef(false);
  const loaded = state.key === key && key !== "";
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const refresh = useCallback(() => setAsk((a) => ({ key, n: a.n + 1 })), [key]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!key || !sessionId || ask.key !== key || ask.n === 0) return;
    // Saving the marks asks again.
    if (marking.current > 0) return;
    const controller = new AbortController();
    const asked = pathsRef.current;
    const askedAt = performance.now();
    const run = ++runRef.current;
    fetching.current = true;
    askAgain.current = false;
    setLoadingKey(key);
    fetchSessionFileChanges(projectName, sessionId, asked, controller.signal)
      .then((files) => {
        put({ key, files });
        announceSessionChanges({ projectName, sessionId, files, paths: asked, askedAt });
      })
      // Keep the last list: a failed refresh says nothing about what changed.
      .catch(() => {})
      .finally(() => {
        // A newer ask replaced this one: it owns the spinner now.
        if (runRef.current !== run) return;
        fetching.current = false;
        setLoadingKey("");
        if (askAgain.current) refreshRef.current();
      });
    return () => controller.abort();
  }, [ask, key, projectName, sessionId, put]);

  // The rows of the files the agent has just changed, pushed by the server.
  useEffect(() => {
    if (!key) return;
    const onPush = (e: Event) => {
      const detail = (e as CustomEvent<SessionFileChangesPushEvent>).detail;
      if (detail.projectName !== projectName || detail.sessionId !== sessionId) return;
      if (fetching.current || marking.current > 0) {
        askAgain.current = true;
        return;
      }
      const current = stateRef.current;
      // Nothing listed for this session yet: its first answer will have these rows.
      if (current.key !== key) return;
      const files = withPushedChanges(current.files, detail.files, detail.gone);
      put({ key, files });
      announceSessionChanges({ projectName, sessionId, files, paths: pathsRef.current, askedAt: performance.now() });
    };
    window.addEventListener(SESSION_FILE_CHANGES_PUSH, onPush);
    return () => window.removeEventListener(SESSION_FILE_CHANGES_PUSH, onPush);
  }, [key, projectName, sessionId, put]);

  // Pushes missed while the socket was down, or a server that restarted and keeps no list.
  useEffect(() => onGlobalReady(() => {
    if (loadedRef.current) refresh();
  }), [refresh]);

  // The count is a directory listing on the server: asked on opening the chat and when a turn ends.
  useEffect(() => {
    if (!key || !sessionId || isStreaming) return;
    const controller = new AbortController();
    fetchSessionChangeCount(projectName, sessionId, controller.signal)
      .then((n) => setCount({ key, n }))
      .catch(() => {});
    return () => controller.abort();
  }, [key, projectName, sessionId, isStreaming]);

  // Marks saved from a Review tab change what this list hides — worth asking again only if
  // the list was ever asked for.
  useEffect(() => {
    const onMarks = (e: Event) => {
      const detail = (e as CustomEvent<{ projectName: string; sessionId: string }>).detail;
      if (detail.projectName === projectName && detail.sessionId === sessionId && loadedRef.current) refresh();
    };
    window.addEventListener(SESSION_REVIEW_MARKS_EVENT, onMarks);
    return () => window.removeEventListener(SESSION_REVIEW_MARKS_EVENT, onMarks);
  }, [projectName, sessionId, refresh]);

  const setReviewed = useCallback((targets: SessionFileChange[], reviewed: boolean) => {
    if (!key || !sessionId || targets.length === 0) return;
    const paths = new Set(targets.map((f) => f.path));
    marking.current++;
    const current = stateRef.current;
    if (current.key === key) put({ key, files: withReviewed(current.files, paths, reviewed) });
    setSessionFilesReviewed(projectName, sessionId, targets, reviewed)
      // The list asked for next says what was saved, and brings back a row that was not.
      .catch(() => {})
      .finally(() => {
        marking.current--;
        refresh();
      });
  }, [key, projectName, sessionId, refresh, put]);

  // A list fetched for the previous session is never shown under this one.
  const unloadedCount = Math.max(paths.length, count.key === key ? count.n : 0);
  return { files: loaded ? state.files : [], paths, unloadedCount, loaded, loading: loadingKey === key && key !== "", refresh, setReviewed };
}
