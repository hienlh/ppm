/**
 * Re-exports fuzzy search from shared module.
 * Provides backward-compatible `searchSlashItems` wrapper typed to `SlashItem`.
 */
export { levenshtein, scoreFuzzy } from "../../shared/fuzzy-search.ts";
import { searchFuzzy } from "../../shared/fuzzy-search.ts";
import type { SlashItem } from "./types.ts";

/** Backward-compatible wrapper — delegates to shared searchFuzzy */
export function searchSlashItems(
  items: SlashItem[],
  query: string,
  limit = 20,
  recentNames: string[] = [],
): SlashItem[] {
  return searchFuzzy(items, query, limit, recentNames);
}
