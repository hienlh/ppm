import { create } from "zustand";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "ppm-settings";

interface SettingsState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

function loadPersistedTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as { theme?: Theme };
      if (
        parsed.theme === "light" ||
        parsed.theme === "dark" ||
        parsed.theme === "system"
      ) {
        return parsed.theme;
      }
    }
  } catch {
    // ignore
  }
  return "dark";
}

function persistTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme }));
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

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: loadPersistedTheme(),

  setTheme: (theme) => {
    persistTheme(theme);
    applyThemeClass(theme);
    set({ theme });
  },
}));
