/**
 * The Assistant's notebook as Settings shows it (`GET /api/assistant/notes`), fetched on mount and
 * again whenever `assistant:notes_changed` arrives (a write by the Assistant, another device, or
 * this one), and after a `/ws/global` reconnect, when an announcement may have been missed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listNotes } from "@/lib/assistant-settings-client";
import { onGlobalReady } from "@/lib/global-ws-channel";
import { NOTES_CHANGED_EVENT, type AssistantNotesView } from "../../shared/assistant-notes";

export function useAssistantNotes(): { view: AssistantNotesView | null; error: string | null; reload: () => Promise<void> } {
  const [view, setView] = useState<AssistantNotesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Counts requests, so an answer that started before a newer one cannot overwrite it. */
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await listNotes();
      if (mine === seq.current) { setView(next); setError(null); }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const onChange = () => void reload();
    window.addEventListener(NOTES_CHANGED_EVENT, onChange);
    const offReady = onGlobalReady(onChange);
    return () => {
      window.removeEventListener(NOTES_CHANGED_EVENT, onChange);
      offReady();
    };
  }, [reload]);

  return { view, error, reload };
}
