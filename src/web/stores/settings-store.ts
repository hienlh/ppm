import { create } from "zustand";
import { getAuthToken } from "@/lib/api-client";
import type { PpmTheme, PpmThemeMode, PpmThemeStyle } from "@/theme/types";
import { parseQualityChoice, type QualityChoice } from "../../shared/remote-desktop-quality";
import {
  clampCustomFps, clampCustomQualityPercent,
} from "../../shared/remote-desktop-custom-quality";
import {
  clampCustomScale, parseViewStyle, type ViewStyle,
} from "@/components/remote-desktop/remote-desktop-view-style";

export type GitStatusViewMode = "flat" | "tree";
export type EditorTabStyle = "default" | "boxed" | "pill";
/** Where the panel dock sits relative to the main content (VS Code-style). Per-user pref. */
export type DockPosition = "left" | "bottom" | "right";
/** OS Explorer window chrome — "auto" follows the host `platform` (Linux → macOS look). */
export type ExplorerSkinPref = "auto" | "windows" | "macos";
/** Settings is deliberately absent: it opens as its own floating window (or a tab on mobile),
 *  never as a sidebar panel. See `settings/use-open-settings.ts`. */
export type SidebarActiveTab = "explorer" | "git" | "database" | "search" | "jira" | "ai-resources" | "history" | "tunnels" | "teams" | `ext:${string}`;

/** Expanded nodes of the Database sidebar tree. Table keys are `${connId}:${schema}.${table}`. */
export interface DbSidebarExpanded {
  conns: number[];
  groups: string[];
  tables: string[];
}

const STORAGE_KEY = "ppm-settings";

interface SettingsState {
  themeStyle: PpmThemeStyle;
  themeMode: PpmThemeMode;
  /** Id of the selected imported theme when themeStyle === "custom". */
  customThemeId?: string;
  /** Imported themes (populated in Phase 3). */
  customThemes: PpmTheme[];
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  gitStatusViewMode: GitStatusViewMode;
  /** GitLens-style annotation after the cursor's line in the code editor. */
  inlineBlame: boolean;
  wordWrap: boolean;
  /** Word wrap on a phone-sized viewport. Device-local — see `persistDevicePref`. */
  mobileWordWrap: boolean;
  /**
   * Run a language server for the open file. Off until asked, and device-local:
   * one `typescript-language-server` was 854 MB resident, which is a reasonable
   * thing to spend on a desktop and never a reasonable thing for a phone to
   * turn on because a desktop did.
   */
  lspEnabled: boolean;
  tabWrap: boolean;
  editorTabStyle: EditorTabStyle;
  sidebarActiveTab: SidebarActiveTab;
  /** User-customized sidebar tab order (shared mobile↔desktop). Empty = default order. */
  sidebarTabOrder: SidebarActiveTab[];
  jiraEnabled: boolean;
  dockPosition: DockPosition;
  dbSidebarExpanded: DbSidebarExpanded;
  explorerSkin: ExplorerSkinPref;
  /** Show/hide the small fps/KB-per-s/resolution overlay on the remote-desktop viewer
   *  (desktop window and mobile full-screen view both read this same flag). */
  remoteDesktopStatsVisible: boolean;
  /** User ticked "don't show again" on the remote-desktop warning that precedes every open
   *  (`remote-desktop-warning-gate.tsx`); once true the viewer connects straight away. */
  remoteDesktopWarningDismissed: boolean;
  /**
   * Image quality rung to ask for on connect — RustDesk's three, or `"custom"`.
   *
   * It is a *ceiling*, not a pin: the session always adapts beneath it, so there is no `auto`
   * arm to choose (`video_qos.rs`: "user set image quality => update to the maximum ratio").
   *
   * Device-local, for the same reason as `lspEnabled`: it answers "what can this link afford",
   * and a desktop on a LAN must not choose "Good image quality" for a phone on mobile data.
   * What comes back out of localStorage is untrusted the same way a rung off the wire is,
   * hence `parseQualityChoice` below rather than a cast.
   */
  remoteDesktopQuality: QualityChoice;
  /**
   * How the remote screen is fitted into the viewer — RustDesk's three `ViewStyle`s.
   *
   * Device-local like the rung above, and for the same reason: `original` on a 3440×1440 host
   * is a scrollable 1:1 view on a desktop and an unusable pinhole on a phone, so a choice made
   * on one screen must not follow the user to the other.
   */
  remoteDesktopViewStyle: ViewStyle;
  /** Zoom factor for `remoteDesktopViewStyle === "custom"` (RustDesk's 5%–1000%). */
  remoteDesktopCustomScale: number;
  /** Bitrate percentage for `remoteDesktopQuality === "custom"`. Not the ratio: 50 means
   *  ratio 1.0 — see `remote-desktop-custom-quality.ts`. */
  remoteDesktopCustomQualityPercent: number;
  /** Frame rate for the custom rung (RustDesk's 5–120). */
  remoteDesktopCustomFps: number;
  /** RustDesk's "More" checkbox: raises the bitrate ceiling from 100% to 2000%. */
  remoteDesktopCustomQualityMore: boolean;
  /** Draw the host pointer into the captured frames. The grabber takes this at startup, so
   *  changing it respawns ffmpeg (~400ms of held picture) — see `restartCapture`. */
  remoteDesktopShowCursor: boolean;
  /** Two-way clipboard sync. Off means Ctrl+V is forwarded to the host as a plain keystroke,
   *  so the host pastes its *own* clipboard and nothing crosses the connection. */
  remoteDesktopClipboardSync: boolean;
  /**
   * H.264 encoder to ask the host for, or null to take the host's own first choice.
   *
   * Device-local like the rest, which is also why the *server* re-checks it: this pref follows
   * the browser, not the host, so the same phone reaching a second machine arrives asking for
   * the first machine's GPU encoder.
   */
  remoteDesktopCodec: string | null;
  deviceName: string | null;
  version: string | null;
  tunnelActive: boolean;
  setRemoteDesktopQuality: (choice: QualityChoice) => void;
  setRemoteDesktopViewStyle: (style: ViewStyle) => void;
  setRemoteDesktopCustomScale: (scale: number) => void;
  setRemoteDesktopCustomQuality: (percent: number, fps: number) => void;
  setRemoteDesktopCustomQualityMore: (more: boolean) => void;
  setRemoteDesktopShowCursor: (show: boolean) => void;
  setRemoteDesktopClipboardSync: (enabled: boolean) => void;
  setRemoteDesktopCodec: (encoder: string | null) => void;
  setThemeStyle: (style: PpmThemeStyle) => void;
  setThemeMode: (mode: PpmThemeMode) => void;
  setCustomTheme: (id: string) => void;
  setThemeFromPayload: (payload: { style: string; mode: PpmThemeMode; customThemeId?: string }) => void;
  setCustomThemes: (themes: PpmTheme[]) => void;
  fetchThemes: () => Promise<void>;
  importThemeFrom: (req: { source: "json" | "url" | "vsix" | "upload"; value: string; name?: string }) => Promise<PpmTheme[]>;
  deleteCustomTheme: (id: string) => Promise<void>;
  setJiraEnabled: (enabled: boolean) => void;
  setDeviceName: (name: string) => Promise<void>;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setGitStatusViewMode: (mode: GitStatusViewMode) => void;
  toggleInlineBlame: () => void;
  toggleWordWrap: () => void;
  toggleMobileWordWrap: () => void;
  setLspEnabled: (enabled: boolean) => void;
  toggleTabWrap: () => void;
  setEditorTabStyle: (style: EditorTabStyle) => void;
  setSidebarActiveTab: (tab: SidebarActiveTab) => void;
  setSidebarTabOrder: (order: SidebarActiveTab[]) => void;
  setDockPosition: (position: DockPosition) => void;
  setDbSidebarExpanded: (next: DbSidebarExpanded) => void;
  setExplorerSkin: (pref: ExplorerSkinPref) => void;
  toggleRemoteDesktopStatsVisible: () => void;
  setRemoteDesktopWarningDismissed: (dismissed: boolean) => void;
  fetchServerInfo: () => Promise<void>;
  /** Re-push the in-memory theme selection to the server (see the action for why). */
  syncThemeToServer: () => Promise<void>;
}

interface PersistedSettings {
  /** Legacy single-axis theme — migrated to themeStyle/themeMode on load. */
  theme?: string;
  themeStyle?: PpmThemeStyle;
  themeMode?: PpmThemeMode;
  customThemeId?: string;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  gitStatusViewMode?: GitStatusViewMode;
  inlineBlame?: boolean;
  wordWrap?: boolean;
  mobileWordWrap?: boolean;
  lspEnabled?: boolean;
  tabWrap?: boolean;
  editorTabStyle?: EditorTabStyle;
  sidebarActiveTab?: SidebarActiveTab;
  sidebarTabOrder?: SidebarActiveTab[];
  jiraEnabled?: boolean;
  dockPosition?: DockPosition;
  dbSidebarExpanded?: DbSidebarExpanded;
  explorerSkin?: ExplorerSkinPref;
  remoteDesktopStatsVisible?: boolean;
  remoteDesktopWarningDismissed?: boolean;
  remoteDesktopQuality?: QualityChoice;
  remoteDesktopViewStyle?: ViewStyle;
  remoteDesktopCustomScale?: number;
  remoteDesktopCustomQualityPercent?: number;
  remoteDesktopCustomFps?: number;
  remoteDesktopCustomQualityMore?: boolean;
  remoteDesktopShowCursor?: boolean;
  remoteDesktopClipboardSync?: boolean;
  remoteDesktopCodec?: string | null;
}

const VALID_STYLES: PpmThemeStyle[] = ["aurora", "slate", "precision", "custom"];
const VALID_MODES: PpmThemeMode[] = ["dark", "light", "system"];

function loadPersistedSettings(): PersistedSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as PersistedSettings;
  } catch {
    // ignore
  }
  return {};
}

/** Resolve the initial {style, mode} from persisted settings, migrating the legacy `theme` string. */
function initialTheme(p: PersistedSettings): { style: PpmThemeStyle; mode: PpmThemeMode; customThemeId?: string } {
  if (p.themeStyle && VALID_STYLES.includes(p.themeStyle) && p.themeMode && VALID_MODES.includes(p.themeMode)) {
    return { style: p.themeStyle, mode: p.themeMode, customThemeId: p.customThemeId };
  }
  // Legacy: "light" | "dark" | "system" → Aurora + that mode
  if (p.theme && VALID_MODES.includes(p.theme as PpmThemeMode)) {
    return { style: "aurora", mode: p.theme as PpmThemeMode };
  }
  // No stored selection: follow the OS rather than forcing dark.
  return { style: "aurora", mode: "system" };
}

function isValidSidebarTab(tab: unknown): tab is SidebarActiveTab {
  if (typeof tab !== "string") return false;
  return ["explorer", "git", "database", "search", "jira", "ai-resources", "history", "tunnels", "teams"].includes(tab) || tab.startsWith("ext:");
}

/** Keep only valid, de-duplicated tab ids — guards against garbage in persisted/server data. */
function sanitizeTabOrder(value: unknown): SidebarActiveTab[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: SidebarActiveTab[] = [];
  for (const item of value) {
    if (isValidSidebarTab(item) && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

// "__ungrouped__" is the synthetic group holding connections without a group.
const DEFAULT_DB_EXPANDED: DbSidebarExpanded = { conns: [], groups: ["__ungrouped__"], tables: [] };

// Caps keep the pref small enough to ride along with every ui-prefs write.
// Server mirrors these limits in its validator.
const DB_EXPANDED_CAPS = { conns: 200, groups: 200, tables: 500 } as const;

/** Coerce stored/server data into a valid expansion set; null when unusable. */
function sanitizeDbExpanded(value: unknown): DbSidebarExpanded | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const strings = (raw: unknown, cap: number) =>
    Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 300).slice(0, cap)
      : [];
  return {
    conns: Array.isArray(v.conns)
      ? v.conns.filter((x): x is number => typeof x === "number" && Number.isInteger(x)).slice(0, DB_EXPANDED_CAPS.conns)
      : [],
    groups: strings(v.groups, DB_EXPANDED_CAPS.groups),
    tables: strings(v.tables, DB_EXPANDED_CAPS.tables),
  };
}

function persistSettings(update: Partial<PersistedSettings>) {
  const current = loadPersistedSettings();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...update }));
}

// UI prefs are also pushed to the server so they survive origin changes
// (localStorage is origin-scoped — switching tunnel URL gives an empty store).
// Theme has its own dedicated endpoint, so theme keys are excluded here.
let _serverPushTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingServerPatch: Partial<PersistedSettings> = {};

function pushUiPrefsToServer(update: Partial<PersistedSettings>) {
  const { theme: _t, themeStyle: _ts, themeMode: _tm, customThemeId: _tc, ...rest } = update;
  if (Object.keys(rest).length === 0) return;
  Object.assign(_pendingServerPatch, rest);
  if (_serverPushTimer) clearTimeout(_serverPushTimer);
  // Debounce so rapid changes (e.g. sidebar drag) collapse into one request.
  _serverPushTimer = setTimeout(() => {
    const patch = _pendingServerPatch;
    _pendingServerPatch = {};
    _serverPushTimer = null;
    const token = getAuthToken();
    fetch("/api/settings/ui-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }, 400);
}

/** Persist UI prefs both locally (instant) and to the server (debounced). */
function persistUiPref(update: Partial<PersistedSettings>) {
  persistSettings(update);
  pushUiPrefsToServer(update);
}

/**
 * Persist a pref to this device only.
 *
 * The server round-trip above exists so prefs survive an origin change, but it
 * also means the last device to write wins everywhere. That is wrong for the
 * prefs that answer "what can this screen afford": a desktop turning the
 * language server on must not start one for the phone, and unwrapping lines on
 * a 27-inch monitor must not unwrap them on a 6-inch one. Those stay local, and
 * `applyServerUiPrefs` deliberately does not read them back.
 */
function persistDevicePref(update: Partial<PersistedSettings>) {
  persistSettings(update);
}

/**
 * Push the current theme selection to the dedicated server endpoint.
 * Errors are swallowed, so callers may ignore the promise; awaiting it only
 * matters when a following request must observe the write (see
 * `syncThemeToServer`).
 */
function pushThemeToServer(
  style: PpmThemeStyle,
  mode: PpmThemeMode,
  customThemeId?: string,
): Promise<void> {
  const token = getAuthToken();
  return fetch("/api/settings/theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ style, mode, ...(customThemeId ? { customThemeId } : {}) }),
  })
    .then(() => {})
    .catch(() => {});
}

/** Apply server-stored UI prefs to the store + localStorage (no re-push). */
function applyServerUiPrefs(data: Record<string, unknown>) {
  const patch: Partial<PersistedSettings> = {};
  if (typeof data.wordWrap === "boolean") patch.wordWrap = data.wordWrap;
  if (typeof data.inlineBlame === "boolean") patch.inlineBlame = data.inlineBlame;
  if (typeof data.tabWrap === "boolean") patch.tabWrap = data.tabWrap;
  if (typeof data.sidebarCollapsed === "boolean") patch.sidebarCollapsed = data.sidebarCollapsed;
  if (typeof data.sidebarWidth === "number" && data.sidebarWidth >= 200 && data.sidebarWidth <= 600) {
    patch.sidebarWidth = data.sidebarWidth;
  }
  if (data.gitStatusViewMode === "flat" || data.gitStatusViewMode === "tree") {
    patch.gitStatusViewMode = data.gitStatusViewMode;
  }
  if (data.editorTabStyle === "default" || data.editorTabStyle === "boxed" || data.editorTabStyle === "pill") {
    patch.editorTabStyle = data.editorTabStyle;
  }
  if (isValidSidebarTab(data.sidebarActiveTab)) patch.sidebarActiveTab = data.sidebarActiveTab;
  if (Array.isArray(data.sidebarTabOrder)) patch.sidebarTabOrder = sanitizeTabOrder(data.sidebarTabOrder);
  if (typeof data.jiraEnabled === "boolean") patch.jiraEnabled = data.jiraEnabled;
  if (data.dockPosition === "left" || data.dockPosition === "bottom" || data.dockPosition === "right") {
    patch.dockPosition = data.dockPosition;
  }
  if (data.explorerSkin === "auto" || data.explorerSkin === "windows" || data.explorerSkin === "macos") {
    patch.explorerSkin = data.explorerSkin;
  }
  if (typeof data.remoteDesktopStatsVisible === "boolean") patch.remoteDesktopStatsVisible = data.remoteDesktopStatsVisible;
  if (typeof data.remoteDesktopWarningDismissed === "boolean") patch.remoteDesktopWarningDismissed = data.remoteDesktopWarningDismissed;
  const dbExpanded = sanitizeDbExpanded(data.dbSidebarExpanded);
  if (dbExpanded) patch.dbSidebarExpanded = dbExpanded;
  if (Object.keys(patch).length === 0) return;
  persistSettings(patch);
  useSettingsStore.setState(patch as Partial<SettingsState>);
}

const _initial = loadPersistedSettings();
const _initialTheme = initialTheme(_initial);

export const useSettingsStore = create<SettingsState>((set, get) => ({
  themeStyle: _initialTheme.style,
  themeMode: _initialTheme.mode,
  customThemeId: _initialTheme.customThemeId,
  customThemes: [],
  sidebarCollapsed: _initial.sidebarCollapsed ?? false,
  sidebarWidth: _initial.sidebarWidth ?? 280,
  gitStatusViewMode: _initial.gitStatusViewMode === "flat" ? "flat" : "tree",
  inlineBlame: _initial.inlineBlame ?? false,
  wordWrap: _initial.wordWrap ?? false,
  remoteDesktopQuality: parseQualityChoice(_initial.remoteDesktopQuality),
  remoteDesktopViewStyle: parseViewStyle(_initial.remoteDesktopViewStyle),
  remoteDesktopCustomScale: clampCustomScale(_initial.remoteDesktopCustomScale),
  // `More` is read first: it decides the ceiling the percentage is clamped to, so clamping in
  // the other order would silently cut a stored 500% back to 100% on every reload.
  remoteDesktopCustomQualityMore: _initial.remoteDesktopCustomQualityMore ?? false,
  remoteDesktopCustomQualityPercent: clampCustomQualityPercent(
    _initial.remoteDesktopCustomQualityPercent, _initial.remoteDesktopCustomQualityMore ?? false,
  ),
  remoteDesktopCustomFps: clampCustomFps(_initial.remoteDesktopCustomFps),
  remoteDesktopShowCursor: _initial.remoteDesktopShowCursor ?? true,
  remoteDesktopClipboardSync: _initial.remoteDesktopClipboardSync ?? true,
  remoteDesktopCodec: typeof _initial.remoteDesktopCodec === "string" ? _initial.remoteDesktopCodec : null,
  mobileWordWrap: _initial.mobileWordWrap ?? true,
  lspEnabled: _initial.lspEnabled ?? false,
  tabWrap: _initial.tabWrap ?? false,
  editorTabStyle: (_initial.editorTabStyle === "boxed" || _initial.editorTabStyle === "pill") ? _initial.editorTabStyle : "default",
  sidebarActiveTab: isValidSidebarTab(_initial.sidebarActiveTab) ? _initial.sidebarActiveTab : "history",
  sidebarTabOrder: sanitizeTabOrder(_initial.sidebarTabOrder),
  jiraEnabled: _initial.jiraEnabled ?? false,
  dockPosition: (_initial.dockPosition === "left" || _initial.dockPosition === "right") ? _initial.dockPosition : "bottom",
  dbSidebarExpanded: sanitizeDbExpanded(_initial.dbSidebarExpanded) ?? DEFAULT_DB_EXPANDED,
  explorerSkin: (_initial.explorerSkin === "windows" || _initial.explorerSkin === "macos") ? _initial.explorerSkin : "auto",
  remoteDesktopStatsVisible: _initial.remoteDesktopStatsVisible ?? false,
  remoteDesktopWarningDismissed: _initial.remoteDesktopWarningDismissed ?? false,
  deviceName: null,
  version: null,
  tunnelActive: false,

  setThemeStyle: (style) => {
    const mode = get().themeMode;
    const customThemeId = style === "custom" ? get().customThemeId : undefined;
    persistSettings({ themeStyle: style, customThemeId });
    set({ themeStyle: style, customThemeId });
    pushThemeToServer(style, mode, customThemeId);
  },

  setThemeMode: (mode) => {
    persistSettings({ themeMode: mode });
    set({ themeMode: mode });
    pushThemeToServer(get().themeStyle, mode, get().customThemeId);
  },

  setCustomTheme: (id) => {
    persistSettings({ themeStyle: "custom", customThemeId: id });
    set({ themeStyle: "custom", customThemeId: id });
    pushThemeToServer("custom", get().themeMode, id);
  },

  setThemeFromPayload: ({ style, mode, customThemeId }) => {
    const resolvedStyle = VALID_STYLES.includes(style as PpmThemeStyle) ? (style as PpmThemeStyle) : "aurora";
    const resolvedMode = VALID_MODES.includes(mode) ? mode : "system";
    persistSettings({ themeStyle: resolvedStyle, themeMode: resolvedMode, customThemeId });
    set({ themeStyle: resolvedStyle, themeMode: resolvedMode, customThemeId });
  },

  setCustomThemes: (themes) => set({ customThemes: themes }),

  fetchThemes: async () => {
    try {
      const { fetchImportedThemes } = await import("@/lib/api-themes");
      set({ customThemes: await fetchImportedThemes() });
    } catch {}
  },

  importThemeFrom: async (req) => {
    const { importTheme } = await import("@/lib/api-themes");
    const created = await importTheme(req);
    await get().fetchThemes();
    return created;
  },

  deleteCustomTheme: async (id) => {
    const { deleteImportedTheme } = await import("@/lib/api-themes");
    await deleteImportedTheme(id);
    await get().fetchThemes();
    // If the deleted theme was active, fall back to Aurora Dark.
    if (get().themeStyle === "custom" && get().customThemeId === id) {
      persistSettings({ themeStyle: "aurora", themeMode: get().themeMode, customThemeId: undefined });
      set({ themeStyle: "aurora", customThemeId: undefined });
      pushThemeToServer("aurora", get().themeMode);
    }
  },

  setDeviceName: async (name) => {
    const trimmed = name.trim();
    set({ deviceName: trimmed || null });
    if (trimmed) {
      document.title = `PPM — ${trimmed}`;
    } else {
      document.title = "PPM";
    }
    try {
      const { updateDeviceName } = await import("@/lib/api-settings");
      await updateDeviceName(trimmed);
    } catch {}
  },

  setJiraEnabled: (enabled) => {
    persistUiPref({ jiraEnabled: enabled });
    set({ jiraEnabled: enabled });
    // If disabling and currently on jira tab, switch to explorer
    if (!enabled && get().sidebarActiveTab === "jira") {
      const tab: SidebarActiveTab = "explorer";
      persistUiPref({ sidebarActiveTab: tab });
      set({ sidebarActiveTab: tab });
    }
  },

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    persistUiPref({ sidebarCollapsed: next });
    set({ sidebarCollapsed: next });
  },

  setSidebarWidth: (width) => {
    const clamped = Math.max(200, Math.min(600, width));
    persistUiPref({ sidebarWidth: clamped });
    set({ sidebarWidth: clamped });
  },

  setGitStatusViewMode: (mode) => {
    persistUiPref({ gitStatusViewMode: mode });
    set({ gitStatusViewMode: mode });
  },

  toggleInlineBlame: () => {
    const next = !get().inlineBlame;
    persistUiPref({ inlineBlame: next });
    set({ inlineBlame: next });
  },

  toggleWordWrap: () => {
    const next = !get().wordWrap;
    persistUiPref({ wordWrap: next });
    set({ wordWrap: next });
  },

  toggleMobileWordWrap: () => {
    const next = !get().mobileWordWrap;
    persistDevicePref({ mobileWordWrap: next });
    set({ mobileWordWrap: next });
  },

  setLspEnabled: (enabled) => {
    persistDevicePref({ lspEnabled: enabled });
    set({ lspEnabled: enabled });
  },

  setRemoteDesktopQuality: (choice) => {
    persistDevicePref({ remoteDesktopQuality: choice });
    set({ remoteDesktopQuality: choice });
  },

  setRemoteDesktopViewStyle: (style) => {
    persistDevicePref({ remoteDesktopViewStyle: style });
    set({ remoteDesktopViewStyle: style });
  },

  setRemoteDesktopCustomScale: (scale) => {
    const next = clampCustomScale(scale);
    persistDevicePref({ remoteDesktopCustomScale: next });
    set({ remoteDesktopCustomScale: next });
  },

  setRemoteDesktopCustomQuality: (percent, fps) => {
    const next = {
      remoteDesktopCustomQualityPercent: clampCustomQualityPercent(percent, get().remoteDesktopCustomQualityMore),
      remoteDesktopCustomFps: clampCustomFps(fps),
    };
    persistDevicePref(next);
    set(next);
  },

  setRemoteDesktopCustomQualityMore: (more) => {
    // Turning it off has to re-clamp: a 500% left over from when it was on is out of range.
    const percent = clampCustomQualityPercent(get().remoteDesktopCustomQualityPercent, more);
    const next = { remoteDesktopCustomQualityMore: more, remoteDesktopCustomQualityPercent: percent };
    persistDevicePref(next);
    set(next);
  },

  setRemoteDesktopShowCursor: (show) => {
    persistDevicePref({ remoteDesktopShowCursor: show });
    set({ remoteDesktopShowCursor: show });
  },

  setRemoteDesktopClipboardSync: (enabled) => {
    persistDevicePref({ remoteDesktopClipboardSync: enabled });
    set({ remoteDesktopClipboardSync: enabled });
  },

  setRemoteDesktopCodec: (encoder) => {
    persistDevicePref({ remoteDesktopCodec: encoder });
    set({ remoteDesktopCodec: encoder });
  },

  toggleTabWrap: () => {
    const next = !get().tabWrap;
    persistUiPref({ tabWrap: next });
    set({ tabWrap: next });
  },

  toggleRemoteDesktopStatsVisible: () => {
    const next = !get().remoteDesktopStatsVisible;
    persistUiPref({ remoteDesktopStatsVisible: next });
    set({ remoteDesktopStatsVisible: next });
  },

  setRemoteDesktopWarningDismissed: (dismissed) => {
    persistUiPref({ remoteDesktopWarningDismissed: dismissed });
    set({ remoteDesktopWarningDismissed: dismissed });
  },

  setEditorTabStyle: (style) => {
    persistUiPref({ editorTabStyle: style });
    set({ editorTabStyle: style });
  },

  setSidebarActiveTab: (tab) => {
    persistUiPref({ sidebarActiveTab: tab });
    set({ sidebarActiveTab: tab });
  },

  setSidebarTabOrder: (order) => {
    const clean = sanitizeTabOrder(order);
    persistUiPref({ sidebarTabOrder: clean });
    set({ sidebarTabOrder: clean });
  },

  setDockPosition: (position) => {
    persistUiPref({ dockPosition: position });
    set({ dockPosition: position });
  },

  setDbSidebarExpanded: (next) => {
    const clean = sanitizeDbExpanded(next) ?? DEFAULT_DB_EXPANDED;
    persistUiPref({ dbSidebarExpanded: clean });
    set({ dbSidebarExpanded: clean });
  },

  setExplorerSkin: (pref) => {
    persistUiPref({ explorerSkin: pref });
    set({ explorerSkin: pref });
  },

  fetchServerInfo: async () => {
    try {
      const token = getAuthToken();
      const authInit = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
      const [infoRes, themeRes, uiPrefsRes] = await Promise.all([
        fetch("/api/info", authInit),
        fetch("/api/settings/theme", authInit),
        fetch("/api/settings/ui-prefs", authInit),
      ]);
      const infoJson = await infoRes.json();
      if (infoJson.ok) {
        const { device_name, version, tunnel_active } = infoJson.data;
        set({ deviceName: device_name || null, version: version || null, tunnelActive: !!tunnel_active });
        if (device_name) {
          document.title = `PPM — ${device_name}`;
        }
      }
      const themeJson = await themeRes.json();
      const serverTheme = themeJson.ok ? themeJson.data?.theme : null;
      if (serverTheme && typeof serverTheme === "object" && typeof serverTheme.style === "string") {
        // Server theme takes precedence — sync to local without re-pushing.
        get().setThemeFromPayload({
          style: serverTheme.style,
          mode: serverTheme.mode,
          customThemeId: serverTheme.customThemeId,
        });
      }
      const uiPrefsJson = await uiPrefsRes.json();
      if (uiPrefsJson.ok && uiPrefsJson.data) {
        applyServerUiPrefs(uiPrefsJson.data as Record<string, unknown>);
      }
      // Load imported themes (auth-gated; safe to call when authenticated).
      void get().fetchThemes();
    } catch {}
  },

  // A theme picked before authenticating cannot reach the server: the endpoint
  // is auth-gated, so that PUT 401s and is dropped. `fetchServerInfo` then lets
  // the *server* theme win and re-runs the moment auth state flips, which would
  // discard the pre-auth choice. Callers that have just obtained a valid token
  // await this first so the PUT lands before that GET reads it back.
  syncThemeToServer: async () => {
    await pushThemeToServer(get().themeStyle, get().themeMode, get().customThemeId);
  },
}));
