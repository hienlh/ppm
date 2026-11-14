/**
 * The PPM Assistant's name from Settings → PPM Assistant, for everything that shows it: the
 * window's titlebar, the Assistant's own head, approval cards, a message it sent into a chat.
 * Empty until known and while none is set, and every reader then shows "Assistant" / "PPM
 * Assistant" as before (`assistantShortName`, `assistantDisplayName`).
 *
 * Fetched once by the first reader; every settings answer this browser receives (load, save,
 * patch — see `assistant-settings-api.ts`) refreshes it, so a save shows at once here. Another
 * device picks a new name up at its next load.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-client";
import { assistantDisplayName, assistantShortName } from "../../shared/assistant-persona";

export const useAssistantNameStore = create<{ name: string }>(() => ({ name: "" }));

let started = false;

/** Reads the name once; a failure (no Assistant on this server, offline) keeps the default. */
export function ensureAssistantNameLoaded(): void {
  if (started) return;
  started = true;
  api.get<{ settings?: { persona?: { name?: unknown } } }>("/api/assistant/settings")
    .then((res) => rememberAssistantName(res?.settings?.persona?.name))
    .catch(() => { started = false; });
}

/** Called with the name from any settings answer. */
export function rememberAssistantName(name: unknown): void {
  const next = typeof name === "string" ? name.trim() : "";
  if (useAssistantNameStore.getState().name !== next) useAssistantNameStore.setState({ name: next });
}

/** For the window titlebar, which reads through a subscribe/read pair rather than a hook. */
export const assistantTitlebarTitle = {
  subscribe(onChange: () => void): () => void {
    ensureAssistantNameLoaded();
    return useAssistantNameStore.subscribe(onChange);
  },
  read: (): string => assistantShortName(useAssistantNameStore.getState()),
};

function useAssistantName(): string {
  useEffect(ensureAssistantNameLoaded, []);
  return useAssistantNameStore((s) => s.name);
}

/** "Mi", else "Assistant": a titlebar or a head. */
export function useAssistantShortName(): string {
  return assistantShortName({ name: useAssistantName() });
}

/** "Mi", else "PPM Assistant": in a sentence. */
export function useAssistantDisplayName(): string {
  return assistantDisplayName({ name: useAssistantName() });
}
