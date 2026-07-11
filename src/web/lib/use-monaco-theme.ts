import { useEffect, useState } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { resolveTheme } from "@/theme/resolve-theme";
import { getCurrentAppliedTheme, THEME_CHANGE_EVENT } from "@/theme/apply-theme";
import { monacoThemeName } from "@/theme/adapters/monaco-adapter";

/** Resolves the current app theme to its registered Monaco theme name. */
export function useMonacoTheme(): string {
  const themeStyle = useSettingsStore((s) => s.themeStyle);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const customThemeId = useSettingsStore((s) => s.customThemeId);
  const customThemes = useSettingsStore((s) => s.customThemes);

  const resolve = () => {
    const theme = getCurrentAppliedTheme() ?? resolveTheme(themeStyle, themeMode, customThemes, customThemeId);
    return monacoThemeName(theme);
  };

  const [name, setName] = useState(resolve);

  useEffect(() => {
    setName(resolve());
    const onChange = () => setName(resolve());
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeStyle, themeMode, customThemeId, customThemes]);

  return name;
}
