/**
 * The settings tree: which categories exist, and how the rail groups them.
 *
 * Data only, no component imports — the window's payload validator and the routing resolver
 * both need to know the legal category ids without pulling every settings section into their
 * bundle. `settings-section-content.tsx` owns the id → component mapping.
 */

import {
  Settings2,
  Palette,
  Bot,
  KeyRound,
  BotMessageSquare,
  BellRing,
  Bug,
  Puzzle,
  Globe,
  CalendarClock,
  Keyboard,
  FolderSearch,
  Database,
  DatabaseZap,
  LayoutGrid,
  Mic,
  Zap,
  Monitor,
  MonitorSmartphone,
} from "@/lib/icons";

/**
 * There is one `accounts` entry, not one per provider: the pane itself carries a sub-tab per
 * configured provider. Claude and Codex share no endpoints or login flow, but "which
 * accounts does PPM have" is a single question, and a rail listing every provider separately
 * would grow a row for each one added.
 */
export type SettingsCategoryId =
  | "general"
  | "appearance"
  | "language-servers"
  | "remote-desktop"
  | "database-drivers"
  | "ai-provider"
  | "accounts"
  | "design"
  | "voice"
  | "ppmbot"
  | "notifications"
  | "jira"
  | "extensions"
  | "proxy"
  | "remote-access"
  | "schedules"
  | "shortcuts"
  | "files"
  | "query-audit";

/**
 * `core` carries no heading: its rows sit at the top of the rail as plain ones, the way a
 * desktop settings app opens on its most-used pane. A heading over them would name the app.
 */
export type SettingsGroupId = "core" | "ai" | "integrations" | "advanced";

export interface SettingsGroupDef {
  id: SettingsGroupId;
  /** Null renders the group's rows without a heading. */
  label: string | null;
}

export interface SettingsCategoryDef {
  id: SettingsCategoryId;
  group: SettingsGroupId;
  label: string;
  /** One line under the label — the rail shows it, the stacked list needs it to be scannable. */
  subtitle: string;
  icon: React.ElementType;
}

export const SETTINGS_GROUPS: SettingsGroupDef[] = [
  { id: "core", label: null },
  { id: "ai", label: "AI & Accounts" },
  { id: "integrations", label: "Integrations" },
  { id: "advanced", label: "Advanced" },
];

export const SETTINGS_CATEGORIES: SettingsCategoryDef[] = [
  { id: "general", group: "core", label: "General", subtitle: "Device name, password, version", icon: Settings2 },
  { id: "appearance", group: "core", label: "Appearance", subtitle: "Theme, tabs, explorer skin", icon: Palette },
  { id: "language-servers", group: "core", label: "Language Servers", subtitle: "Completions and go to definition, per language", icon: Zap },
  { id: "remote-desktop", group: "core", label: "Remote Desktop", subtitle: "WebRTC relay for streaming this host's screen", icon: Monitor },
  { id: "database-drivers", group: "core", label: "Database Drivers", subtitle: "MySQL and MariaDB support, installed on request", icon: Database },

  { id: "ai-provider", group: "ai", label: "AI Provider", subtitle: "Model, execution mode, limits", icon: Bot },
  { id: "accounts", group: "ai", label: "Accounts", subtitle: "Claude and Codex sign-ins, rotation", icon: KeyRound },
  { id: "design", group: "ai", label: "Design", subtitle: "Design instructions and skills", icon: LayoutGrid },
  { id: "voice", group: "ai", label: "Voice Input", subtitle: "Speech to text for the chat box", icon: Mic },

  { id: "ppmbot", group: "integrations", label: "PPMBot", subtitle: "Telegram AI bot", icon: BotMessageSquare },
  { id: "notifications", group: "integrations", label: "Notifications", subtitle: "Push & Telegram alerts", icon: BellRing },
  { id: "jira", group: "integrations", label: "Jira Watcher", subtitle: "Auto-debug Jira tickets", icon: Bug },
  { id: "extensions", group: "integrations", label: "Extensions", subtitle: "Install and manage extensions", icon: Puzzle },
  { id: "proxy", group: "integrations", label: "API Proxy", subtitle: "Expose accounts as Anthropic API", icon: Globe },
  { id: "remote-access", group: "integrations", label: "Remote Access", subtitle: "Tailscale, public link", icon: MonitorSmartphone },

  { id: "schedules", group: "advanced", label: "Scheduled Agents", subtitle: "Run Claude on a cron schedule", icon: CalendarClock },
  { id: "shortcuts", group: "advanced", label: "Keyboard Shortcuts", subtitle: "Customize key bindings", icon: Keyboard },
  { id: "files", group: "advanced", label: "File Filters", subtitle: "Exclude patterns, ignore files", icon: FolderSearch },
  { id: "query-audit", group: "advanced", label: "Query Audit Log", subtitle: "SQL history retention and size", icon: DatabaseZap },
];

/**
 * Dispatched on `window` with a category id as `detail` when something asks for a pane while
 * Settings is already open. The host's payload or tab metadata only seeds the first render, so
 * without this a link into an open Settings would raise it on whatever pane it was showing.
 */
export const SETTINGS_NAVIGATE_EVENT = "ppm:settings-navigate";

/** The pane a window with no remembered category opens on. */
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryId = "general";

/**
 * Narrows an unknown value (a persisted window payload, a URL fragment) to a real category.
 * Anything unrecognised falls back rather than rendering an empty pane.
 */
export function isSettingsCategoryId(value: unknown): value is SettingsCategoryId {
  return typeof value === "string" && SETTINGS_CATEGORIES.some((c) => c.id === value);
}

export function settingsCategory(id: SettingsCategoryId): SettingsCategoryDef {
  // Non-null: the id type is closed over SETTINGS_CATEGORIES, so every member has an entry.
  return SETTINGS_CATEGORIES.find((c) => c.id === id)!;
}

/** Categories of one group, in declaration order. */
export function settingsCategoriesInGroup(group: SettingsGroupId): SettingsCategoryDef[] {
  return SETTINGS_CATEGORIES.filter((c) => c.group === group);
}
