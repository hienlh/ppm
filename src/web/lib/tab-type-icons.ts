/**
 * Shared tab-type → lucide icon map.
 *
 * Single source of truth so the mobile nav, dock header, and tab bar render the
 * same glyph per tab type. Adding a new panel tab type = one entry here, no
 * per-component change (extensibility invariant for the generalized dock).
 */
import {
  Terminal, MessageSquare, FileCode, Database, FileDiff, Settings, Globe, Puzzle, Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { TabType } from "@/stores/tab-store";

export const TAB_TYPE_ICONS: Record<TabType, LucideIcon> = {
  terminal: Terminal,
  chat: MessageSquare,
  editor: FileCode,
  database: Database,
  sqlite: Database,
  postgres: Database,
  "git-diff": FileDiff,
  settings: Settings,
  tunnels: Globe,
  extension: Puzzle,
  "extension-webview": Puzzle,
  "conflict-editor": FileDiff,
  "system-monitor": Settings,
  "git-log": FileCode,
  "ai-resource": Sparkles,
};

/** Resolve the icon for a tab type, falling back to a generic glyph. */
export function getTabTypeIcon(type: TabType): LucideIcon {
  return TAB_TYPE_ICONS[type] ?? Puzzle;
}
