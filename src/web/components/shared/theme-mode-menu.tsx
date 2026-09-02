import { memo } from "react";
import { Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useSettingsStore } from "@/stores/settings-store";
import { THEME_MODE_OPTIONS } from "@/theme/theme-mode-options";
import { cn } from "@/lib/utils";

interface ThemeModeMenuProps {
  /** Positioning / spacing for the trigger button. */
  className?: string;
}

/**
 * Icon-button dropdown for picking the theme mode (Light / Dark / System).
 *
 * Mode-only on purpose: this is used where the full theme *style* grid does not
 * fit or is not yet reachable (the login screen runs pre-auth, so imported
 * themes cannot be fetched). The trigger is a 44px touch target per the
 * mobile-first UI rules.
 */
export const ThemeModeMenu = memo(function ThemeModeMenu({ className }: ThemeModeMenuProps) {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);

  const active = THEME_MODE_OPTIONS.find((o) => o.value === themeMode) ?? THEME_MODE_OPTIONS[2]!;
  const ActiveIcon = active.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`Appearance: ${active.label}`}
          aria-label={`Appearance: ${active.label}`}
          className={cn(
            "flex size-11 items-center justify-center rounded-xl text-text-subtle",
            "can-hover:hover:bg-surface-elevated can-hover:hover:text-foreground",
            className,
          )}
        >
          <ActiveIcon className="size-[18px]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        {THEME_MODE_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          return (
            <DropdownMenuItem
              key={opt.value}
              onClick={() => setThemeMode(opt.value)}
              className="gap-2"
            >
              <Icon className="size-4 shrink-0" />
              <span className="flex-1 truncate">{opt.label}</span>
              <Check
                className={cn(
                  "size-4 shrink-0",
                  themeMode === opt.value ? "opacity-100" : "opacity-0",
                )}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
