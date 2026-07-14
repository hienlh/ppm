import { listSlashItemsDetailed } from "../slash-discovery/index.ts";
import type { SlashItemWithSource } from "../slash-discovery/types.ts";
import type { AiResourceItem, AiResourceGroup, AiResourceListResult } from "./types.ts";

const MANAGED_TYPES = new Set(["skill", "agent", "command"]);
const GROUP_ORDER: AiResourceGroup["type"][] = ["skill", "agent", "command"];

function toItem(
  src: SlashItemWithSource,
  shadowed: boolean,
  shadowedBy?: { name: string; source: SlashItemWithSource["source"] },
  overrides?: number,
): AiResourceItem {
  return {
    type: src.type as AiResourceItem["type"],
    name: src.name,
    description: src.description,
    scope: src.scope,
    source: src.source,
    filePath: src.filePath,
    rootPath: src.rootPath,
    argumentHint: src.argumentHint,
    model: src.model,
    tools: src.tools,
    readOnly: src.source === "bundled",
    shadowed,
    shadowedBy,
    overrides,
  };
}

/**
 * List all managed AI resources (skills, agents, commands) for a project,
 * including shadowed duplicates, grouped by type with priority-order stats.
 */
export function listAiResources(projectPath: string): AiResourceListResult {
  const { active, shadowed } = listSlashItemsDetailed(projectPath);

  // Count how many lower-priority items each active item overrides.
  const overrideCounts = new Map<string, number>();
  for (const s of shadowed) {
    const key = `${s.type}:${s.name}`;
    overrideCounts.set(key, (overrideCounts.get(key) ?? 0) + 1);
  }

  const items: AiResourceItem[] = [];
  for (const a of active) {
    if (!MANAGED_TYPES.has(a.type)) continue;
    const key = `${a.type}:${a.name}`;
    items.push(toItem(a, false, undefined, overrideCounts.get(key)));
  }
  for (const s of shadowed) {
    if (!MANAGED_TYPES.has(s.type)) continue;
    items.push(toItem(s, true, s.shadowedBy));
  }

  const groups: AiResourceGroup[] = GROUP_ORDER.map((type) => ({
    type,
    items: items
      .filter((i) => i.type === type)
      .sort((a, b) => {
        if (a.shadowed !== b.shadowed) return a.shadowed ? 1 : -1;
        return a.name.localeCompare(b.name);
      }),
  })).filter((g) => g.items.length > 0);

  const activeManaged = items.filter((i) => !i.shadowed);
  const stats = {
    active: activeManaged.length,
    project: activeManaged.filter((i) => i.scope === "project").length,
    user: activeManaged.filter((i) => i.scope === "user").length,
    bundled: activeManaged.filter((i) => i.scope === "bundled").length,
    shadowed: items.filter((i) => i.shadowed).length,
  };

  return { groups, stats };
}
