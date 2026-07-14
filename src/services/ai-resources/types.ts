import type { SlashItemType, SlashItemScope, DefinitionSource, ItemOrigin } from "../slash-discovery/types.ts";

/** A managed AI resource (skill / agent / command) surfaced in the AI Resources panel. */
export interface AiResourceItem {
  type: Extract<SlashItemType, "skill" | "agent" | "command">;
  name: string;
  description: string;
  scope: SlashItemScope;
  source: DefinitionSource;
  filePath: string;
  rootPath: string;
  argumentHint?: string;
  model?: string;
  tools?: string[];
  /** Bundled resources ship with the package and cannot be edited/deleted in place. */
  readOnly: boolean;
  /** True when a higher-priority resource of the same type+name overrides this one. */
  shadowed: boolean;
  /** When shadowed, which source won. When active but overriding others, the count. */
  shadowedBy?: { name: string; source: DefinitionSource };
  /** Number of lower-priority resources this active item overrides. */
  overrides?: number;
}

export interface AiResourceGroup {
  type: "skill" | "agent" | "command";
  items: AiResourceItem[];
}

export interface AiResourceListResult {
  groups: AiResourceGroup[];
  stats: { active: number; project: number; user: number; bundled: number; shadowed: number };
}

export type CreatableScope = "project" | "user";
export type CreatableType = "skill" | "agent" | "command";

/** Maps a resource type to its discovery origin directory name. */
export const TYPE_TO_ORIGIN: Record<CreatableType, ItemOrigin> = {
  skill: "skills",
  agent: "agents",
  command: "commands",
};
