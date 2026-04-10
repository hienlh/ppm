import { discoverSkillRoots } from "./discover-skill-roots.ts";
import { loadItemsFromRoots } from "./skill-loader.ts";
import { resolveOverrides } from "./resolve-overrides.ts";
import { getBuiltinSlashItems } from "./builtin-commands.ts";
import type { SlashItem, SlashItemWithSource, DiscoveryResult } from "./types.ts";

export { searchSlashItems } from "./fuzzy-search.ts";
export { isPpmHandled, getBuiltinByName } from "./builtin-commands.ts";
export { executeBuiltin } from "./builtin-handlers.ts";
export type { SlashItem, SlashItemWithSource, ShadowedItem, DiscoveryResult, SkillRoot, DefinitionSource } from "./types.ts";

/**
 * Full discovery pipeline: roots → load → resolve overrides → prepend builtins.
 * Returns active items, shadowed items, and discovered roots.
 */
export function listSlashItemsDetailed(projectPath: string): DiscoveryResult {
  const roots = discoverSkillRoots(projectPath);
  const rawItems = loadItemsFromRoots(roots);
  const result = resolveOverrides(rawItems, roots);

  // Prepend builtins (not subject to shadowing — unique type namespace)
  const builtinItems: SlashItemWithSource[] = getBuiltinSlashItems().map((item) => ({
    ...item,
    source: "bundled" as const,
    rootPath: "",
    filePath: "",
  }));

  return {
    ...result,
    active: [...builtinItems, ...result.active],
  };
}

/**
 * Backward-compatible: returns flat list of active items (no source metadata).
 * Same signature as the original `listSlashItems()`.
 */
export function listSlashItems(projectPath: string): SlashItem[] {
  const { active } = listSlashItemsDetailed(projectPath);
  return active.map(({ source, rootPath, filePath, ...item }) => item);
}
