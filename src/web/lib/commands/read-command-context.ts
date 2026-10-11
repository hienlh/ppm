import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useKeybindingsStore } from "@/stores/keybindings-store";
import { useExtensionStore } from "@/stores/extension-store";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { isTouchOnlyDevice } from "@/hooks/use-is-touch-only";
import type { CommandContext } from "./command-registry";

/**
 * The context a command runs in, read from the stores as they are right now: for the callers
 * that are not a component — a keyboard shortcut, a request from the PPM Assistant. The palette
 * builds the same object from its own hooks, so both see what the screen shows.
 */
export function readCommandContext(): CommandContext {
  return {
    project: useProjectStore.getState().activeProject ?? null,
    isMobile: isMobileDevice(),
    isTouchOnly: isTouchOnlyDevice(),
    lspEnabled: useSettingsStore.getState().lspEnabled,
    getBinding: useKeybindingsStore.getState().getBinding,
    extensions: useExtensionStore.getState().contributions,
  };
}
