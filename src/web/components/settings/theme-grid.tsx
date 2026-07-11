import { Check } from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import { BUILTIN_ORDER, BUILTIN_THEMES } from "@/theme/builtin";
import { resolveTheme } from "@/theme/resolve-theme";
import { ThemeSwatch } from "./theme-swatch";
import { cn } from "@/lib/utils";

/**
 * 2-column grid of the 6 built-in themes. Works on desktop + mobile; tapping a
 * card applies that style+mode instantly. Active card gets an accent ring + check.
 */
export function ThemeGrid() {
  const themeStyle = useSettingsStore((s) => s.themeStyle);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const customThemeId = useSettingsStore((s) => s.customThemeId);
  const customThemes = useSettingsStore((s) => s.customThemes);
  const setThemeStyle = useSettingsStore((s) => s.setThemeStyle);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);

  const active = resolveTheme(themeStyle, themeMode, customThemes, customThemeId);

  return (
    <div className="grid grid-cols-2 gap-2">
      {BUILTIN_ORDER.map((id) => {
        const t = BUILTIN_THEMES[id];
        if (!t) return null;
        const isActive = active.id === id;
        return (
          <button
            key={id}
            onClick={() => { setThemeStyle(t.style); setThemeMode(t.mode); }}
            className={cn(
              "relative flex items-center gap-2 rounded-lg border p-2 text-left transition-colors min-h-11",
              isActive ? "border-primary ring-[3px] ring-accent-wash" : "border-border hover:bg-accent/40",
            )}
          >
            <ThemeSwatch swatch={t.swatch} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-text">{t.name.replace(/ (Dark|Light)$/, "")}</span>
              <span className="block text-[10px] text-text-3 capitalize">{t.mode}</span>
            </span>
            {isActive && <Check className="absolute top-1 right-1 size-3.5 text-primary" />}
          </button>
        );
      })}
    </div>
  );
}
