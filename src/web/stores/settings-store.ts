import { create } from "zustand";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "ppm-settings";

interface SettingsState {
  theme: Theme;
  sidebarCollapsed: boolean;
  deviceName: string | null;
  version: string | null;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  fetchServerInfo: () => Promise<void>;
}

interface PersistedSettings {
  theme?: Theme;
  sidebarCollapsed?: boolean;
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
  theme: (_initial.theme === "light" || _initial.theme === "dark" || _initial.theme === "system") ? _initial.theme : "dark",
  sidebarCollapsed: _initial.sidebarCollapsed ?? false,
  deviceName: null,
  version: null,

  setTheme: (theme) => {
    persistSettings({ theme });
    applyThemeClass(theme);
    set({ theme });
  },

  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    persistSettings({ sidebarCollapsed: next });
    set({ sidebarCollapsed: next });
  },

  fetchServerInfo: async () => {
    try {
      const res = await fetch("/api/info");
      const json = await res.json();
      if (json.ok) {
        const { device_name, version } = json.data;
        set({ deviceName: device_name || null, version: version || null });
        if (device_name) {
          document.title = `PPM — ${device_name}`;
        }
      }
    } catch {}
  },
}));
