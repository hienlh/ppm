import { compareSourcePriority } from "./definition-source.ts";
import type { SlashItemWithSource, ShadowedItem, DiscoveryResult, SkillRoot } from "./types.ts";

/**
 * Resolve override/shadowing conflicts among discovered items.
 * Groups by `type:name` key. Highest-priority source wins; others become shadowed.
 */
export function resolveOverrides(
  items: SlashItemWithSource[],
  roots: SkillRoot[],
): DiscoveryResult {
  const groups = new Map<string, SlashItemWithSource[]>();

  for (const item of items) {
    const key = `${item.type}:${item.name}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const active: SlashItemWithSource[] = [];
  const shadowed: ShadowedItem[] = [];

  for (const group of groups.values()) {
    // Sort by source priority (lowest numeric = highest priority)
    group.sort((a, b) => compareSourcePriority(a.source, b.source));

    const winner = group[0]!;
    active.push(winner);

    // Rest are shadowed
    for (let i = 1; i < group.length; i++) {
      shadowed.push({
        ...group[i]!,
        shadowedBy: { name: winner.name, source: winner.source },
      });
    }
  }

  return { active, shadowed, roots };
}
