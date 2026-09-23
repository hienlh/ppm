import { usePanelStore } from "@/stores/panel-store";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";
import { designTabMetadata } from "./design-tab-metadata";

export interface OpenDesignTabInput {
  projectName: string;
  slug: string;
  title?: string;
  /** Open the design on this session (history, a notification) instead of its current one. */
  sessionId?: string;
  providerId?: string;
  /** The panel to open in when the design is not open yet. */
  panelId?: string;
  /** Just created: skip looking up its latest session, it has none. */
  fresh?: boolean;
}

/**
 * Open (or focus) a design's tab. There is one tab per design; opening it again focuses
 * the existing tab, and asking for a particular session switches that tab to it.
 */
export function openDesignTab(input: OpenDesignTabInput): string {
  const { projectName, slug, title, sessionId, providerId, panelId, fresh } = input;
  const id = usePanelStore.getState().openTab({
    type: "design",
    title: title || slug,
    projectId: projectName,
    closable: true,
    metadata: designTabMetadata({ projectName, designSlug: slug, sessionId, providerId, fresh }),
  }, panelId);
  if (!id || !sessionId) return id;

  // The tab already existed, so the panel store focused it and ignored the metadata above.
  // Bumping the epoch remounts its chat on the requested session.
  const current = currentTabMetadata(id);
  if (current && current.sessionId !== sessionId) {
    patchTabMetadata(id, {
      sessionId,
      ...(providerId ? { providerId, providerPending: undefined } : {}),
      pendingMessage: undefined,
      designChatEpoch: nextChatEpoch(current),
    });
  }
  return id;
}

/** The epoch after the one `metadata` carries; the design tab keys its chat on it. */
export function nextChatEpoch(metadata: Record<string, unknown> | undefined): number {
  const epoch = metadata?.designChatEpoch;
  return (typeof epoch === "number" && Number.isFinite(epoch) ? epoch : 0) + 1;
}

export interface SessionToOpen {
  id: string;
  providerId?: string;
  title?: string;
  designSlug?: string | null;
}

/**
 * Open a session from a history list in the tab it belongs to: a design session in its
 * design tab, anything else as a chat tab. The panel store also focuses an already-open
 * design tab for a session opened as a chat, but only this can open one that is closed.
 */
export function openSessionInItsTab(session: SessionToOpen, projectName: string, panelId?: string): string {
  if (session.designSlug) {
    return openDesignTab({
      projectName, slug: session.designSlug, sessionId: session.id, providerId: session.providerId, panelId,
    });
  }
  return usePanelStore.getState().openTab({
    type: "chat",
    title: session.title || "Chat",
    projectId: projectName,
    metadata: { projectName, sessionId: session.id, ...(session.providerId ? { providerId: session.providerId } : {}) },
    closable: true,
  }, panelId);
}
