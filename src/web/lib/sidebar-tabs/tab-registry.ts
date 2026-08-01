import {
  FolderOpen, GitBranch, Settings, Database, Search, Puzzle, Bug, Sparkles, BotMessageSquare, Globe, Users,
} from "lucide-react";
import type { SidebarActiveTab } from "@/stores/settings-store";
import type { ExtensionContributes } from "../../../types/extension";

export type SidebarTabId = SidebarActiveTab;

export interface SidebarTabDef {
  id: SidebarTabId;
  /** Full label (desktop rail tooltip / expanded view). */
  label: string;
  /** Compact label for the mobile bottom bar; falls back to `label`. */
  shortLabel?: string;
  icon: React.ElementType;
  /** Marks the tab's feature as beta — renders a small "beta" tag on the rail + mobile bar. */
  beta?: boolean;
}

/**
 * Canonical built-in sidebar tabs in default order. Single source of truth for
 * both the desktop rail (nav-section-rail) and the mobile drawer. Dynamic tabs
 * (Jira, extension views) are merged in by getAvailableTabs.
 */
export const BUILTIN_SIDEBAR_TABS: SidebarTabDef[] = [
  { id: "history", label: "Chat History", shortLabel: "History", icon: BotMessageSquare },
  { id: "teams", label: "Teams", icon: Users, beta: true },
  { id: "explorer", label: "Explorer", icon: FolderOpen },
  { id: "search", label: "Search", icon: Search },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "database", label: "Database", icon: Database },
  { id: "tunnels", label: "Cloudflare Tunnels", shortLabel: "Tunnels", icon: Globe },
  { id: "ai-resources", label: "AI Resources", shortLabel: "AI", icon: Sparkles },
  { id: "settings", label: "Settings", icon: Settings },
];

/**
 * Full available tab set given the current runtime state: built-ins + Jira (when
 * enabled, inserted before Settings) + extension sidebar views appended at end.
 * Mirrors the merge logic previously inlined in nav-section-rail.tsx.
 */
export function getAvailableTabs(opts: {
  jiraEnabled: boolean;
  contributions?: ExtensionContributes | null;
}): SidebarTabDef[] {
  const tabs: SidebarTabDef[] = [...BUILTIN_SIDEBAR_TABS];

  if (opts.jiraEnabled) {
    const settingsIdx = tabs.findIndex((t) => t.id === "settings");
    const jira: SidebarTabDef = { id: "jira", label: "Jira", icon: Bug };
    if (settingsIdx >= 0) tabs.splice(settingsIdx, 0, jira);
    else tabs.push(jira);
  }

  const views = opts.contributions?.views;
  if (views) {
    const sidebarViews = views["sidebar"] ?? views["explorer"] ?? [];
    for (const view of sidebarViews) {
      tabs.push({ id: `ext:${view.id}` as SidebarTabId, label: view.name, icon: Puzzle });
    }
  }

  return tabs;
}
