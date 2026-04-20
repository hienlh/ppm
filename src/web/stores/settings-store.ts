import { create } from "zustand";
import { getAuthToken } from "@/lib/api-client";
import hljsDarkUrl from "highlight.js/styles/github-dark-dimmed.min.css?url";
import hljsLightUrl from "highlight.js/styles/github.min.css?url";

export type Theme = "light" | "dark" | "system";
export type GitStatusViewMode = "flat" | "tree";
export type SidebarActiveTab = "explorer" | "git" | "settings" | "database" | "search" | "jira" | `ext:${string}`;

const STORAGE_KEY = "ppm-settings";

interface SettingsState {
  theme: Theme;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  gitStatusViewMode: GitStatusViewMode;
  wordWrap: boolean;
  sidebarActiveTab: SidebarActiveTab;
  jiraEnabled: boolean;
  deviceName: string | null;
  version: string | null;
  setTheme: (theme: Theme) => void;
  setJiraEnabled: (enabled: boolean) => void;
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
  jiraEnabled?: boolean;
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

function isValidSidebarTab(tab: unknown): tab is SidebarActiveTab {
  if (typeof tab !== "string") return false;
  return ["explorer", "git", "settings", "database", "search", "jira"].includes(tab) || tab.startsWith("ext:");
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

  // Swap highlight.js syntax theme to match light/dark mode
  applyHighlightTheme(resolved);

  // Update theme-color meta tag
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute(
      "content",
      resolved === "dark" ? "#0f1419" : "#ffffff",
    );
  }
}

/** Load the matching highlight.js stylesheet for the current theme */
function applyHighlightTheme(resolved: "light" | "dark") {
  const href = resolved === "dark" ? hljsDarkUrl : hljsLightUrl;
  let link = document.getElementById("hljs-theme") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = "hljs-theme";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== new URL(href, document.baseURI).href) {
    link.href = href;
  }
}

const _initial = loadPersistedSettings();

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: (_initial.theme === "light" || _initial.theme === "dark" || _initial.theme === "system") ? _initial.theme : "system",
  sidebarCollapsed: _initial.sidebarCollapsed ?? false,
  sidebarWidth: _initial.sidebarWidth ?? 280,
  gitStatusViewMode: _initial.gitStatusViewMode === "flat" ? "flat" : "tree",
  wordWrap: _initial.wordWrap ?? false,
  sidebarActiveTab: isValidSidebarTab(_initial.sidebarActiveTab) ? _initial.sidebarActiveTab : "explorer",
  jiraEnabled: _initial.jiraEnabled ?? false,
  deviceName: null,
  version: null,

  setTheme: (theme) => {
    persistSettings({ theme });
    applyThemeClass(theme);
    set({ theme });
    // Save to server (fire-and-forget)
    const token = getAuthToken();
    fetch("/api/settings/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

  setJiraEnabled: (enabled) => {
    persistSettings({ jiraEnabled: enabled });
    set({ jiraEnabled: enabled });
    // If disabling and currently on jira tab, switch to explorer
    if (!enabled && get().sidebarActiveTab === "jira") {
      const tab: SidebarActiveTab = "explorer";
      persistSettings({ sidebarActiveTab: tab });
      set({ sidebarActiveTab: tab });
    }
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
      const token = getAuthToken();
      const authInit = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
      const [infoRes, themeRes] = await Promise.all([
        fetch("/api/info", authInit),
        fetch("/api/settings/theme", authInit),
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
