import { useState } from "react";
import { Plus, Trash2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/settings-store";
import { ThemeSwatch } from "./theme-swatch";
import { ThemeImportDialog } from "./theme-import-dialog";
import { cn } from "@/lib/utils";

/** Settings section: list imported themes with apply/delete + an Import button. */
export function ThemeManagerSection() {
  const customThemes = useSettingsStore((s) => s.customThemes);
  const themeStyle = useSettingsStore((s) => s.themeStyle);
  const customThemeId = useSettingsStore((s) => s.customThemeId);
  const setCustomTheme = useSettingsStore((s) => s.setCustomTheme);
  const deleteCustomTheme = useSettingsStore((s) => s.deleteCustomTheme);

  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground">Imported themes</h3>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setDialogOpen(true)}>
          <Plus className="size-3.5" /> Import
        </Button>
      </div>

      {customThemes.length === 0 ? (
        <p className="text-[11px] text-text-3">No imported themes yet. Import a VSCode theme from a URL, .vsix, or JSON.</p>
      ) : (
        <ul className="space-y-1">
          {customThemes.map((t) => {
            const active = themeStyle === "custom" && customThemeId === t.id;
            return (
              <li
                key={t.id}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2 py-1.5",
                  active ? "border-primary bg-primary/10" : "border-border",
                )}
              >
                <ThemeSwatch swatch={t.swatch} />
                <button className="flex-1 min-w-0 text-left" onClick={() => setCustomTheme(t.id)}>
                  <span className="block truncate text-xs text-text">{t.name}</span>
                  <span className="block text-[10px] text-text-3">{t.mode}</span>
                </button>
                {active && <Check className="size-4 text-primary shrink-0" />}
                <button
                  className="text-text-3 hover:text-error transition-colors shrink-0"
                  title="Delete"
                  onClick={() => void deleteCustomTheme(t.id)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <ThemeImportDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </section>
  );
}
