import { memo } from "react";
import { Palette, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useSettingsStore } from "@/stores/settings-store";
import { BUILTIN_ORDER, BUILTIN_THEMES } from "@/theme/builtin";
import { resolveTheme } from "@/theme/resolve-theme";
import { ThemeSwatch } from "./theme-swatch";
import { cn } from "@/lib/utils";

/** Status-bar palette button that opens a theme picker (6 built-ins + imports). */
export const ThemePicker = memo(function ThemePicker() {
  const themeStyle = useSettingsStore((s) => s.themeStyle);
  const themeMode = useSettingsStore((s) => s.themeMode);
  const customThemeId = useSettingsStore((s) => s.customThemeId);
  const customThemes = useSettingsStore((s) => s.customThemes);
  const setThemeStyle = useSettingsStore((s) => s.setThemeStyle);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const setCustomTheme = useSettingsStore((s) => s.setCustomTheme);

  const active = resolveTheme(themeStyle, themeMode, customThemes, customThemeId);

  const pick = (id: string) => {
    const t = BUILTIN_THEMES[id];
    if (!t) return;
    setThemeStyle(t.style);
    setThemeMode(t.mode);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title="Theme"
          aria-label="Theme"
          className="flex items-center gap-1 px-1 rounded-sm transition-colors hover:bg-accent/40 hover:text-text-primary"
        >
          <Palette className="size-[11px]" />
          <span className="truncate max-w-[90px]">{active.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-56">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {BUILTIN_ORDER.map((id) => {
          const t = BUILTIN_THEMES[id];
          if (!t) return null;
          const isActive = active.id === id;
          return (
            <DropdownMenuItem key={id} onClick={() => pick(id)} className="gap-2">
              <ThemeSwatch swatch={t.swatch} />
              <span className="flex-1 truncate">{t.name}</span>
              <Check className={cn("size-4 shrink-0", isActive ? "opacity-100" : "opacity-0")} />
            </DropdownMenuItem>
          );
        })}
        {customThemes.length > 0 && (
          <>
            <DropdownMenuLabel>Imported</DropdownMenuLabel>
            {customThemes.map((t) => {
              const isActive = themeStyle === "custom" && customThemeId === t.id;
              return (
                <DropdownMenuItem key={t.id} onClick={() => setCustomTheme(t.id)} className="gap-2">
                  <ThemeSwatch swatch={t.swatch} />
                  <span className="flex-1 truncate">{t.name}</span>
                  <Check className={cn("size-4 shrink-0", isActive ? "opacity-100" : "opacity-0")} />
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
