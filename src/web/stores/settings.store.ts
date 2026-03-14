import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light" | "system";

interface SettingsStore {
  theme: Theme;
  sidebarOpen: boolean;
  setTheme(theme: Theme): void;
  toggleSidebar(): void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      theme: "dark",
      sidebarOpen: true,

      setTheme(theme) {
        set({ theme });
      },

      toggleSidebar() {
        set((s) => ({ sidebarOpen: !s.sidebarOpen }));
      },
    }),
    {
      name: "ppm-settings",
      partialize: (s) => ({ theme: s.theme, sidebarOpen: s.sidebarOpen }),
    },
  ),
);
