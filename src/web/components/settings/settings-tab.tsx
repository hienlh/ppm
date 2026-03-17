import { Moon, Sun, Monitor, Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore, type Theme } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { AISettingsSection } from "./ai-settings-section";
import { usePushNotification } from "@/hooks/use-push-notification";

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ElementType }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const pushSupported = "PushManager" in window && "serviceWorker" in navigator;
const isIosNonPwa = /iPhone|iPad/.test(navigator.userAgent) &&
  !window.matchMedia("(display-mode: standalone)").matches;

export function SettingsTab() {
  const { theme, setTheme } = useSettingsStore();
  const { permission, isSubscribed, loading, subscribe, unsubscribe } = usePushNotification();

  return (
    <div className="h-full w-full overflow-auto">
    <div className="p-4 space-y-6 max-w-lg mx-auto">
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
        <h3 className="text-sm font-medium text-text-secondary">Notifications</h3>
        {!pushSupported ? (
          <p className="text-sm text-text-subtle">
            Push notifications are not supported in this browser.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {isSubscribed ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                <span className="text-sm">Push notifications</span>
              </div>
              <Button
                variant={isSubscribed ? "default" : "outline"}
                size="sm"
                disabled={loading || permission === "denied"}
                onClick={() => (isSubscribed ? unsubscribe() : subscribe())}
              >
                {loading ? "..." : isSubscribed ? "On" : "Off"}
              </Button>
            </div>
            {permission === "denied" && (
              <p className="text-xs text-destructive">
                Notifications blocked. Enable in browser settings.
              </p>
            )}
            {isIosNonPwa && (
              <p className="text-xs text-text-subtle">
                On iOS, install PPM to Home Screen for push notifications.
              </p>
            )}
          </>
        )}
      </div>

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
    </div>
  );
}
