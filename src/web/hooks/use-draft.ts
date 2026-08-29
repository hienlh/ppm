import { useState, useEffect, useRef, useCallback } from "react";
import { api, projectUrl } from "@/lib/api-client";

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

export function useDraft(projectName: string, sessionId: string | null) {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const effectiveId = sessionId ?? "__new__";

  // Load draft on mount / session change
  useEffect(() => {
    if (!projectName) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Releasing the gate only reveals the composer; a draft arriving afterwards
    // is still applied, and MessageInput refuses to overwrite typed text.
    const releaseTimer = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, GATE_RELEASE_MS);
    api
      .get<DraftResult | null>(
        `${projectUrl(projectName)}/chat/drafts/${encodeURIComponent(effectiveId)}`,
      )
      .then((data) => {
        if (cancelled) return;
        if (data) {
          let attachments: DraftAttachment[] = [];
          try { attachments = JSON.parse(data.attachments); } catch { /* ignore */ }
          setDraft({ content: data.content, attachments });
        } else {
          setDraft(null);
        }
      })
      .catch(() => { if (!cancelled) setDraft(null); })
      .finally(() => {
        clearTimeout(releaseTimer);
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; clearTimeout(releaseTimer); };
  }, [projectName, effectiveId]);

  // Debounced save (1s)
  const save = useCallback(
    (content: string, attachments?: DraftAttachment[]) => {
      if (!projectName) return;
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

  // Clear draft (on send)
  const clear = useCallback(() => {
    if (!projectName) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const id = sessionRef.current ?? "__new__";
    api
      .del(`${projectUrl(projectName)}/chat/drafts/${encodeURIComponent(id)}`)
      .catch(() => {});
    setDraft(null);
  }, [projectName]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { draft, draftLoading: loading, saveDraft: save, clearDraft: clear };
}
