import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { resolveTheme } from "./resolve-theme";
import { applyTheme } from "./apply-theme";
import type { PpmTheme } from "./types";

/**
 * Resolves the active theme from the settings store and applies it to the DOM.
 * Re-applies when the store changes, when the OS color scheme flips (system
 * mode), or when the viewport crosses the mobile breakpoint (mobileOverrides).
 * Mount once near the app root.
 */
export function useTheme(): PpmTheme {
  const themeStyle = useSettingsStore((s) => s.themeStyle);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const customThemeId = useSettingsStore((s) => s.customThemeId);
  const customThemes = useSettingsStore((s) => s.customThemes);

  // Bumped by matchMedia listeners to force re-resolve/re-apply.
  const [tick, setTick] = useState(0);

  const theme = useMemo(
    () => resolveTheme(themeStyle, themeMode, customThemes, customThemeId),
    // tick participates so system-mode / mobile changes recompute
    [themeStyle, themeMode, customThemes, customThemeId, tick],
  );

  useEffect(() => {
    // `tick` is a dep so crossing the mobile breakpoint re-applies mobileOverrides
    // even when the resolved theme object reference is unchanged.
    applyTheme(theme);
  }, [theme, tick]);

  useEffect(() => {
    const schemeMq = window.matchMedia("(prefers-color-scheme: dark)");
    const mobileMq = window.matchMedia("(max-width: 767px)");
    const bump = () => setTick((t) => t + 1);
    schemeMq.addEventListener("change", bump);
    mobileMq.addEventListener("change", bump);
    return () => {
      schemeMq.removeEventListener("change", bump);
      mobileMq.removeEventListener("change", bump);
    };
  }, []);

  return theme;
}
