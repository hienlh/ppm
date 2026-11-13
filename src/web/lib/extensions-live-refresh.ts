import { api } from "@/lib/api-client";
import { useExtensionStore } from "@/stores/extension-store";
import { EXTENSIONS_CHANGED_EVENT } from "../../shared/extensions-events";
import type { ExtensionContributes } from "../../types/extension.ts";

/**
 * `extensions:changed` arrived on `/ws/global`: an extension was installed, removed, enabled or
 * disabled — maybe by another device, the `ppm ext` CLI or the Assistant. Reads the contributions
 * again (palette commands, keybindings, views), then tells open panes (Settings → Extensions) to
 * read their list again through a window event of the same name.
 */
export async function handleExtensionsChanged(): Promise<void> {
  try {
    const contributions = await api.get<ExtensionContributes>("/api/extensions/contributions");
    useExtensionStore.getState().setContributions(contributions);
  } catch { /* the next change or reconnect brings them */ }
  window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED_EVENT));
}
