/** Pure viewport-routing decision for the Settings open-hook — split out from
 *  `use-open-settings.ts` so it has zero runtime imports (only type-only ones, fully
 *  erased) and is unit-testable without mounting zustand stores. */
import type { Tab } from "@/stores/tab-store";
import type { SettingsCategoryId } from "./settings-categories";

export type OpenSettingsAction =
  | { kind: "tab"; tab: Omit<Tab, "id"> }
  | { kind: "window"; category?: SettingsCategoryId }
  | { kind: "focus"; id: string; category?: SettingsCategoryId };

/**
 * There is exactly one set of settings, so unlike `"explorer"`/`"team-member"` (legitimately
 * multi-instance — different payload, different folder/teammate), a second `"settings"`
 * window is never a distinct instance, only a duplicate. When one is already open, focus it
 * instead of spawning another.
 *
 * `category` rides through every branch, not just the opening ones: focusing an existing
 * window still has to move it to the requested pane, or a "manage accounts" link would raise
 * a window sitting on some unrelated pane and look like it did nothing. On the tab branch it
 * travels as tab metadata, which tabs already carry and persist — no new field needed.
 *
 * Mobile never gets a window: `WindowLayer` renders nothing below the `md` breakpoint, so
 * opening one there is a silent no-op.
 */
export function resolveOpenSettingsAction(
  isMobile: boolean,
  existingWindowId: string | null,
  category?: SettingsCategoryId,
): OpenSettingsAction {
  if (isMobile) {
    return {
      kind: "tab",
      tab: {
        type: "settings",
        title: "Settings",
        projectId: null,
        closable: true,
        ...(category && { metadata: { category } }),
      },
    };
  }
  if (existingWindowId) return { kind: "focus", id: existingWindowId, ...(category && { category }) };
  return { kind: "window", ...(category && { category }) };
}
