import { CORE_SETTINGS } from "./settings-catalog-core.ts";
import { aiSettings } from "./settings-catalog-ai.ts";
import { REFUSED_SETTINGS, UNCOVERED_CATEGORIES, refusedSetting } from "./settings-catalog-refused.ts";
import type { RefusedSetting, SettingEntry } from "./settings-catalog-types.ts";

/**
 * The whole catalog: what the Assistant may change (`allSettings`), what it may only name
 * (`REFUSED_SETTINGS`), and which Settings categories hold neither (`UNCOVERED_CATEGORIES`). A key
 * found in none of them is "not offered" — the agent is told to send the user to the pane.
 */

/** Every changeable setting, provider rows built from the providers configured now. */
export function allSettings(): SettingEntry[] {
  return [...CORE_SETTINGS, ...aiSettings()];
}

export type CatalogLookup =
  | { kind: "setting"; entry: SettingEntry }
  | { kind: "refused"; refused: RefusedSetting }
  | { kind: "unknown" };

export function lookupSetting(key: string): CatalogLookup {
  // A refused key wins even if a pattern elsewhere would match it: refusing is the safe answer.
  const refused = refusedSetting(key);
  if (refused) return { kind: "refused", refused };
  const entry = allSettings().find((e) => e.key === key);
  return entry ? { kind: "setting", entry } : { kind: "unknown" };
}

/** The categories with something in the catalog, the refused list, or a stated reason. */
export function coveredCategories(): Set<string> {
  return new Set([
    ...allSettings().map((e) => e.category),
    ...REFUSED_SETTINGS.map((r) => r.category),
    ...UNCOVERED_CATEGORIES.map((u) => u.category),
  ]);
}

/** Where in PPM a category's pane opens: the link a refusal and a card point at. */
export const settingsLinkPath = (category: string): string => `/?openSettings=${encodeURIComponent(category)}`;
