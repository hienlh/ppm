import type { DefinitionSource, SlashItemScope } from "./types.ts";

/** Numeric priority — lower = higher priority */
export const SOURCE_PRIORITY: Record<DefinitionSource, number> = {
  "project-ppm": 0,
  "project-claw": 1,
  "project-codex": 2,
  "project-claude": 3,
  "env-var": 4,
  "user-ppm": 5,
  "user-claw": 6,
  "user-codex": 7,
  "user-claude": 8,
  "bundled": 9,
};

/** Compare two sources by priority (for sorting highest-priority first) */
export function compareSourcePriority(a: DefinitionSource, b: DefinitionSource): number {
  return SOURCE_PRIORITY[a] - SOURCE_PRIORITY[b];
}

/** Map a DefinitionSource to the user-facing scope label */
export function sourceToScope(source: DefinitionSource): SlashItemScope {
  if (source === "bundled") return "bundled";
  if (source.startsWith("project-") || source === "env-var") return "project";
  return "user";
}
