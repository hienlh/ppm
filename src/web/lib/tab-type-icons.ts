/**
 * Shared tab-type → icon map.
 *
 * Single source of truth so the mobile nav, dock header, and tab bar render the
 * same glyph per tab type. Adding a new panel tab type = one entry here, no
 * per-component change (extensibility invariant for the generalized dock).
 */
import {
  Terminal, MessageSquare, FileCode, Database, FileDiff, Settings, Puzzle, Sparkles, Users, CircleX,
  GitCommitHorizontal,
  type LucideIcon,
} from "@/lib/icons";
import type { ElementType } from "react";
import type { TabType } from "@/stores/tab-store";
import { fileIconElement } from "@/lib/file-icons";
import { PROVIDER_LOGOS } from "@/lib/provider-logos";

export const TAB_TYPE_ICONS: Record<TabType, LucideIcon> = {
  terminal: Terminal,
  chat: MessageSquare,
  editor: FileCode,
  database: Database,
  sqlite: Database,
  postgres: Database,
  "git-diff": FileDiff,
  "branch-review": FileDiff,
  settings: Settings,
  extension: Puzzle,
  "extension-webview": Puzzle,
  "conflict-editor": FileDiff,
  "system-monitor": Settings,
  "git-log": GitCommitHorizontal,
  "ai-resource": Sparkles,
  group: Users,
  problems: CircleX,
};

/** Resolve the icon for a tab type, falling back to a generic glyph. */
export function getTabTypeIcon(type: TabType): LucideIcon {
  return TAB_TYPE_ICONS[type] ?? Puzzle;
}

/** The tab types whose title names a file rather than a kind of panel. */
const FILE_TAB_TYPES = new Set<TabType>(["editor", "git-diff", "conflict-editor"]);

export interface TabIconSubject {
  type: TabType;
  title: string;
  metadata?: Record<string, unknown>;
}

/**
 * A tab that holds a file is labelled with *that file's* icon, the way VS Code
 * does it — a strip of eight identical `FileCode` glyphs tells you nothing about
 * which tab is which, and that is just as true of the dock header and the mobile
 * tab switcher as it is of the desktop strip. The tab's own metadata is
 * preferred over its title, which a rename or a "(hash)" suffix can have edited.
 *
 * A chat tab is labelled the same way and for the same reason, with the logo of
 * the provider running it. A tab carrying no provider is a chat that has not
 * started yet, and one of those runs Claude — `ChatTab`'s own default — so it is
 * drawn as one rather than as a question mark.
 */
export function getTabIcon(tab: TabIconSubject): ElementType {
  if (FILE_TAB_TYPES.has(tab.type)) {
    const path = (tab.metadata?.filePath as string | undefined) || tab.title;
    if (path) return fileIconElement(path);
  }
  if (tab.type === "chat") {
    const logo = PROVIDER_LOGOS[(tab.metadata?.providerId as string | undefined) ?? "claude"];
    if (logo) return logo;
  }
  return getTabTypeIcon(tab.type);
}
