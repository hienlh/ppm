import { create } from "zustand";

export type Theme = "light" | "dark" | "system";
export type GitStatusViewMode = "flat" | "tree";
export type SidebarActiveTab = "explorer" | "git" | "settings" | "database" | "search";

const STORAGE_KEY = "ppm-settings";

interface SettingsState {
  theme: Theme;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  gitStatusViewMode: GitStatusViewMode;
  wordWrap: boolean;
  sidebarActiveTab: SidebarActiveTab;
  deviceName: string | null;
  version: string | null;
  setTheme: (theme: Theme) => void;
  setDeviceName: (name: string) => Promise<void>;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setGitStatusViewMode: (mode: GitStatusViewMode) => void;
  toggleWordWrap: () => void;
  setSidebarActiveTab: (tab: SidebarActiveTab) => void;
  fetchServerInfo: () => Promise<void>;
}

interface PersistedSettings {
  theme?: Theme;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  gitStatusViewMode?: GitStatusViewMode;
  wordWrap?: boolean;
  sidebarActiveTab?: SidebarActiveTab;
}

function loadPersistedSettings(): PersistedSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as PersistedSettings;
  } catch {
    // ignore
  }
  return {};
}

function persistSettings(update: Partial<PersistedSettings>) {
  const current = loadPersistedSettings();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...update }));
}

/** Apply the resolved theme class to <html> */
export function applyThemeClass(theme: Theme) {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("light", resolved === "light");

  // Update theme-color meta tag
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute(
      "content",
      resolved === "dark" ? "#0f1419" : "#ffffff",
    );
  }
}

const _initial = loadPersistedSettings();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: (_initial.theme === "light" || _initial.theme === "dark" || _initial.theme === "system") ? _initial.theme : "system",
  sidebarCollapsed: _initial.sidebarCollapsed ?? false,
  sidebarWidth: _initial.sidebarWidth ?? 280,
  gitStatusViewMode: _initial.gitStatusViewMode === "flat" ? "flat" : "tree",
  wordWrap: _initial.wordWrap ?? false,
  sidebarActiveTab: (["git", "settings", "database", "search"] as SidebarActiveTab[]).includes(_initial.sidebarActiveTab as SidebarActiveTab) ? _initial.sidebarActiveTab! : "explorer",
  deviceName: null,
  version: null,

  setTheme: (theme) => {
    persistSettings({ theme });
    applyThemeClass(theme);
    set({ theme });
    // Save to server (fire-and-forget)
    fetch("/api/settings/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    }).catch(() => {});
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

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    persistSettings({ sidebarCollapsed: next });
    set({ sidebarCollapsed: next });
  },

  setSidebarWidth: (width) => {
    const clamped = Math.max(200, Math.min(600, width));
    persistSettings({ sidebarWidth: clamped });
    set({ sidebarWidth: clamped });
  },

  setGitStatusViewMode: (mode) => {
    persistSettings({ gitStatusViewMode: mode });
    set({ gitStatusViewMode: mode });
  },

  toggleWordWrap: () => {
    const next = !get().wordWrap;
    persistSettings({ wordWrap: next });
    set({ wordWrap: next });
  },

  setSidebarActiveTab: (tab) => {
    persistSettings({ sidebarActiveTab: tab });
    set({ sidebarActiveTab: tab });
  },

  fetchServerInfo: async () => {
    try {
      const [infoRes, themeRes] = await Promise.all([
        fetch("/api/info"),
        fetch("/api/settings/theme"),
      ]);
      const infoJson = await infoRes.json();
      if (infoJson.ok) {
        const { device_name, version } = infoJson.data;
        set({ deviceName: device_name || null, version: version || null });
        if (device_name) {
          document.title = `PPM — ${device_name}`;
        }
      }
      const themeJson = await themeRes.json();
      if (themeJson.ok && themeJson.data?.theme) {
        const serverTheme = themeJson.data.theme as Theme;
        // Server theme takes precedence — sync to local
        persistSettings({ theme: serverTheme });
        applyThemeClass(serverTheme);
        set({ theme: serverTheme });
      }
    } catch {}
  },
}));
