import {
  FolderOpen,
  GitBranch,
  Database,
  Search,
  Puzzle,
  Bug,
  Sparkles,
  BotMessageSquare,
  Globe,
  Users,
} from "@/lib/icons";
import type { SidebarActiveTab } from "@/stores/settings-store";
import type { FeatureBadgeId } from "@/lib/feature-badges";
import type { ExtensionContributes } from "../../../types/extension";

export type SidebarTabId = SidebarActiveTab;

export interface SidebarTabDef {
  id: SidebarTabId;
  /** Full label (desktop rail tooltip / expanded view). */
  label: string;
  /** Compact label for the mobile bottom bar; falls back to `label`. */
  shortLabel?: string;
  icon: React.ElementType;
  /** Feature tag ("new"/"beta") looked up in `lib/feature-badges.ts`; rendered on the rail + mobile bar. */
  badge?: FeatureBadgeId;
}

/**
 * Canonical built-in sidebar tabs in default order. Single source of truth for
 * both the desktop rail (nav-section-rail) and the mobile drawer. Dynamic tabs
 * (Jira, extension views) are merged in by getAvailableTabs.
 */
export const BUILTIN_SIDEBAR_TABS: SidebarTabDef[] = [
  { id: "history", label: "Chat History", shortLabel: "History", icon: BotMessageSquare },
  { id: "teams", label: "Teams", icon: Users, badge: "teams" },
  { id: "explorer", label: "Explorer", icon: FolderOpen },
  { id: "search", label: "Search", icon: Search },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "database", label: "Database", icon: Database },
  { id: "tunnels", label: "Cloudflare Tunnels", shortLabel: "Tunnels", icon: Globe },
  { id: "ai-resources", label: "AI Resources", shortLabel: "AI", icon: Sparkles },
];

/**
 * Full available tab set given the current runtime state: built-ins + Jira (when enabled) +
 * extension sidebar views appended at end. Mirrors the merge logic previously inlined in
 * nav-section-rail.tsx.
 *
 * Jira goes after the built-ins and before extension views. It used to be spliced in ahead of
 * a Settings entry that no longer exists here — Settings opens its own window now — and the
 * resulting position is the same one, so the splice became a plain append.
 */
export function getAvailableTabs(opts: {
  jiraEnabled: boolean;
  contributions?: ExtensionContributes | null;
}): SidebarTabDef[] {
  const tabs: SidebarTabDef[] = [...BUILTIN_SIDEBAR_TABS];

  if (opts.jiraEnabled) {
    tabs.push({ id: "jira", label: "Jira", icon: Bug });
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
