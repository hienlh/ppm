import { create } from "zustand";
import { getAuthToken } from "@/lib/api-client";
import type { PpmTheme, PpmThemeMode, PpmThemeStyle } from "@/theme/types";

export type GitStatusViewMode = "flat" | "tree";
export type EditorTabStyle = "default" | "boxed" | "pill";
/** Where the panel dock sits relative to the main content (VS Code-style). Per-user pref. */
export type DockPosition = "left" | "bottom" | "right";
export type SidebarActiveTab = "explorer" | "git" | "settings" | "database" | "search" | "jira" | "ai-resources" | "history" | `ext:${string}`;

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
  wordWrap: boolean;
  tabWrap: boolean;
  editorTabStyle: EditorTabStyle;
  sidebarActiveTab: SidebarActiveTab;
  jiraEnabled: boolean;
  dockPosition: DockPosition;
  deviceName: string | null;
  version: string | null;
  tunnelActive: boolean;
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
  toggleWordWrap: () => void;
  toggleTabWrap: () => void;
  setEditorTabStyle: (style: EditorTabStyle) => void;
  setSidebarActiveTab: (tab: SidebarActiveTab) => void;
  setDockPosition: (position: DockPosition) => void;
  fetchServerInfo: () => Promise<void>;
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
  wordWrap?: boolean;
  tabWrap?: boolean;
  editorTabStyle?: EditorTabStyle;
  sidebarActiveTab?: SidebarActiveTab;
  jiraEnabled?: boolean;
  dockPosition?: DockPosition;
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
  return { style: "aurora", mode: "dark" };
}

function isValidSidebarTab(tab: unknown): tab is SidebarActiveTab {
  if (typeof tab !== "string") return false;
  return ["explorer", "git", "settings", "database", "search", "jira", "ai-resources", "history"].includes(tab) || tab.startsWith("ext:");
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

/** Push the current theme selection to the dedicated server endpoint (fire-and-forget). */
function pushThemeToServer(style: PpmThemeStyle, mode: PpmThemeMode, customThemeId?: string) {
  const token = getAuthToken();
  fetch("/api/settings/theme", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ style, mode, ...(customThemeId ? { customThemeId } : {}) }),
  }).catch(() => {});
}

/** Apply server-stored UI prefs to the store + localStorage (no re-push). */
function applyServerUiPrefs(data: Record<string, unknown>) {
  const patch: Partial<PersistedSettings> = {};
  if (typeof data.wordWrap === "boolean") patch.wordWrap = data.wordWrap;
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
  if (typeof data.jiraEnabled === "boolean") patch.jiraEnabled = data.jiraEnabled;
  if (data.dockPosition === "left" || data.dockPosition === "bottom" || data.dockPosition === "right") {
    patch.dockPosition = data.dockPosition;
  }
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
  wordWrap: _initial.wordWrap ?? false,
  tabWrap: _initial.tabWrap ?? false,
  editorTabStyle: (_initial.editorTabStyle === "boxed" || _initial.editorTabStyle === "pill") ? _initial.editorTabStyle : "default",
  sidebarActiveTab: isValidSidebarTab(_initial.sidebarActiveTab) ? _initial.sidebarActiveTab : "history",
  jiraEnabled: _initial.jiraEnabled ?? false,
  dockPosition: (_initial.dockPosition === "left" || _initial.dockPosition === "right") ? _initial.dockPosition : "bottom",
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
    const resolvedMode = VALID_MODES.includes(mode) ? mode : "dark";
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

  toggleWordWrap: () => {
    const next = !get().wordWrap;
    persistUiPref({ wordWrap: next });
    set({ wordWrap: next });
  },

  toggleTabWrap: () => {
    const next = !get().tabWrap;
    persistUiPref({ tabWrap: next });
    set({ tabWrap: next });
  },

  setEditorTabStyle: (style) => {
    persistUiPref({ editorTabStyle: style });
    set({ editorTabStyle: style });
  },

  setSidebarActiveTab: (tab) => {
    persistUiPref({ sidebarActiveTab: tab });
    set({ sidebarActiveTab: tab });
  },

  setDockPosition: (position) => {
    persistUiPref({ dockPosition: position });
    set({ dockPosition: position });
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
}));
