import { useState, useEffect, useRef, useCallback } from "react";
import { api, projectUrl } from "@/lib/api-client";
import { getPrepare } from "@/lib/new-chat-prepare-client";

export interface DraftAttachment {
  name: string;
  path: string;
}

interface DraftState {
  content: string;
  attachments: DraftAttachment[];
}

/**
 * How long the chat composer may stay hidden waiting for a draft. The composer
 * is gated on `draftLoading`, so a slow or stalled load must not leave the user
 * with no way to type.
 */
const GATE_RELEASE_MS = 3_000;

interface DraftResult {
  content: string;
  attachments: string; // JSON string
  updatedAt: string;
}

export function useDraft(projectName: string, sessionId: string | null, tabId?: string) {
  // The server save is debounced and can fail while offline. Keep the visible
  // composer's draft in this browser tab too, including across a recovery reload.
  const keyForSession = useCallback((id: string | null) =>
    `ppm-chat-draft:${JSON.stringify([projectName, tabId ?? null, id ?? "__new__"])}`, [projectName, tabId]);
  const localKey = keyForSession(sessionId);
  const [recoveredDraft] = useState<DraftState | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(localKey) ?? "null");
      if (typeof value?.content !== "string" || !Array.isArray(value.attachments)) return null;
      return { content: value.content, attachments: value.attachments.filter(
        (a: DraftAttachment) => typeof a?.name === "string" && typeof a?.path === "string",
      ) };
    } catch { return null; }
  });
  const recoveryRef = useRef({ projectName, sessionId, draft: recoveredDraft });
  const localKeyRef = useRef(localKey);
  localKeyRef.current = localKey;
  const [draft, setDraft] = useState<DraftState | null>(recoveredDraft);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sessionRef = useRef(sessionId);
  const editRevision = useRef(0);
  sessionRef.current = sessionId;

  const effectiveId = sessionId ?? "__new__";

  // Load draft on mount / session change
  useEffect(() => {
    if (!projectName) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const revision = editRevision.current;
    // StrictMode repeats mount effects. Keep the recovered value for both
    // runs, but never reuse it after navigating to another conversation.
    if (recoveryRef.current.projectName !== projectName || recoveryRef.current.sessionId !== sessionId) {
      recoveryRef.current.draft = null;
    }
    const keepRecoveredDraft = recoveryRef.current.draft !== null;
    setLoading(true);
    // Releasing the gate only reveals the composer; a draft arriving afterwards
    // is still applied, and MessageInput refuses to overwrite typed text.
    const releaseTimer = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, GATE_RELEASE_MS);
    const fetchFromServer = () => api.get<DraftResult | null>(
      `${projectUrl(projectName)}/chat/drafts/${encodeURIComponent(effectiveId)}`,
    );
    // A sessionless tab's `/chat/prepare` already read the `__new__` draft; joining it
    // (rather than also GETting) only falls back to the plain fetch when the prepare
    // request itself failed — a `draft: null` inside a settled response means "no draft"
    // and is used as-is, the same as the GET path's own null case below.
    const prepared = sessionId === null && tabId ? getPrepare(tabId) : undefined;
    const request = prepared ? prepared.then((result) => result.draft, fetchFromServer) : fetchFromServer();
    request
      .then((data) => {
        if (cancelled || keepRecoveredDraft || editRevision.current !== revision) return;
        if (data) {
          let attachments: DraftAttachment[] = [];
          try { attachments = JSON.parse(data.attachments); } catch { /* ignore */ }
          setDraft({ content: data.content, attachments });
        } else {
          setDraft(null);
        }
      })
      .catch(() => { if (!cancelled && !keepRecoveredDraft && editRevision.current === revision) setDraft(null); })
      .finally(() => {
        clearTimeout(releaseTimer);
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; clearTimeout(releaseTimer); };
  }, [projectName, effectiveId, tabId, sessionId]);

  // Debounced save (1s)
  const save = useCallback(
    (content: string, attachments?: DraftAttachment[]) => {
      ++editRevision.current;
      if (!projectName) return;
      try {
        sessionStorage.setItem(localKeyRef.current, JSON.stringify({ content, attachments: attachments ?? [] }));
      } catch { /* Storage may be unavailable; the server draft still applies. */ }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const id = sessionRef.current ?? "__new__";
        api
          .put(
            `${projectUrl(projectName)}/chat/drafts/${encodeURIComponent(id)}`,
            { content, attachments: JSON.stringify(attachments ?? []) },
          )
          .catch(() => {});
      }, 1000);
    },
    [projectName],
  );

  /**
   * Drop a save that is still waiting on the debounce, without touching the server.
   *
   * Called at Enter. The save runs against whatever session the tab is on when the
   * timer fires — and the first send of a new tab swaps the tab onto its new session
   * within that second, so a save left armed would write the message just sent as the
   * new session's draft, to reappear in the composer on the next mount as if unsent.
   */
  const cancelPendingSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  // Only explicit create/fork transitions move the unsent draft. Picking an
  // unrelated history session must leave its draft under the original owner.
  const moveDraft = useCallback((nextSessionId: string) => {
    const oldKey = localKeyRef.current;
    const nextKey = keyForSession(nextSessionId);
    if (oldKey === nextKey) return;
    try {
      const value = sessionStorage.getItem(oldKey);
      if (value !== null) {
        sessionStorage.setItem(nextKey, value);
        sessionStorage.removeItem(oldKey);
      }
    } catch { /* Preserve the old copy if the new write fails. */ }
  }, [keyForSession]);

  /**
   * Clear the draft once its message has actually been handed to the socket.
   *
   * `draftId` names the draft the message was composed under. The first send of a
   * new tab creates the session and only then sends, so by the time the send
   * happens `sessionRef` already points at the new session while the draft still
   * lives under `__new__` — deleting by the current session id would leave it
   * behind and restore it into the next new tab.
   */
  const clear = useCallback((draftId?: string) => {
    ++editRevision.current;
    if (!projectName) return;
    recoveryRef.current.draft = null;
    try {
      sessionStorage.removeItem(localKeyRef.current);
      if (draftId) sessionStorage.removeItem(keyForSession(draftId === "__new__" ? null : draftId));
    } catch { /* Storage unavailable. */ }
    if (timerRef.current) clearTimeout(timerRef.current);
    const id = draftId ?? sessionRef.current ?? "__new__";
    api
      .del(`${projectUrl(projectName)}/chat/drafts/${encodeURIComponent(id)}`)
      .catch(() => {});
    setDraft(null);
  }, [projectName, keyForSession]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { draft, draftLoading: loading, saveDraft: save, clearDraft: clear, cancelPendingSave, moveDraft };
}
