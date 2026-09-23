import { usePanelStore } from "@/stores/panel-store";

/**
 * Write some keys of a tab's metadata, keeping every other key as the store has it *now*.
 *
 * Tab components receive their metadata as a prop, and a prop captured by an effect or a
 * callback is a snapshot of whatever was current when it last rendered. Spreading that
 * snapshot back into the store (`{ ...metadata, sessionId }`) silently reverts anything
 * written since — by another component hosting the same tab, by the panel store's own
 * activation stamp, or by a second effect in the same commit. Reading at write time is what
 * makes two writers to one tab safe.
 */
export function patchTabMetadata(tabId: string, patch: Record<string, unknown>): void {
  const store = usePanelStore.getState();
  const current = store.getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId)?.metadata;
  store.updateTab(tabId, { metadata: mergeTabMetadata(current, patch) });
}

/** The pure half: `patch` wins, everything else in `current` is kept. */
export function mergeTabMetadata(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...patch };
}

/** The tab's metadata as the store holds it now, or undefined when the tab is gone. */
export function currentTabMetadata(tabId: string): Record<string, unknown> | undefined {
  return usePanelStore.getState().getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId)?.metadata;
}
