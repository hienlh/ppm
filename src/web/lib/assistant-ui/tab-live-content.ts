import { useEffect, useRef } from "react";
import type { ShownRows } from "../../../shared/assistant-tab-content";

/**
 * What a mounted tab holds that no store does — an editor's text since its last save, the
 * rows a database grid shows — for the PPM Assistant to read (`describe_tab`) and to know
 * when closing a tab would lose work. Each tab component registers a reader while it is
 * mounted; a tab that is not mounted has nothing here, and callers fall back to its metadata.
 */

export type TabLiveContent =
  | { kind: "editor"; dirty: boolean; text: string }
  | { kind: "rows"; rows: ShownRows | null };

const readers = new Map<string, () => TabLiveContent>();

/** Registers `read` for `tabId`; the returned function takes it back (only if it is still the one registered). */
export function registerTabLiveContent(tabId: string, read: () => TabLiveContent): () => void {
  readers.set(tabId, read);
  return () => {
    if (readers.get(tabId) === read) readers.delete(tabId);
  };
}

/** The tab's live content now, or undefined when nothing for it is mounted (or its reader failed). */
export function readTabLiveContent(tabId: string): TabLiveContent | undefined {
  const read = readers.get(tabId);
  if (!read) return undefined;
  try {
    return read();
  } catch (e) {
    console.warn("[assistant-ui] could not read a tab's content:", e);
    return undefined;
  }
}

/**
 * Registers a reader for the component's lifetime. `read` may close over state: the latest
 * one is called, without re-registering on every render.
 */
export function useTabLiveContent(tabId: string | undefined, read: () => TabLiveContent): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => (tabId ? registerTabLiveContent(tabId, () => latest.current()) : undefined), [tabId]);
}
