import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore, type Theme } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { AISettingsSection } from "./ai-settings-section";

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ElementType }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function SettingsTab() {
  const { theme, setTheme } = useSettingsStore();

  return (
    <div className="h-full p-4 space-y-6 overflow-auto max-w-lg">
      <h2 className="text-lg font-semibold">Settings</h2>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">Theme</h3>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <Button
                key={opt.value}
                variant={theme === opt.value ? "default" : "outline"}
                size="lg"
                onClick={() => setTheme(opt.value)}
                className={cn(
                  "flex-1 gap-2",
                  theme === opt.value && "ring-2 ring-primary",
                )}
              >
                <Icon className="size-4" />
                {opt.label}
              </Button>
            );
          })}
        </div>
      </div>

      <Separator />

      <AISettingsSection />

      <Separator />

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary">About</h3>
        <p className="text-sm text-text-secondary">
          PPM — Personal Project Manager
        </p>
        <p className="text-xs text-text-subtle">
          A mobile-first web IDE for managing your projects.
        </p>
      </div>
    </div>
  );
}
