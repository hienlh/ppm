import { useState, useCallback, useRef } from "react";
import {
  Moon, Sun, Monitor, Bell, BellOff, Check, ChevronRight, ArrowLeft,
  Bot, BellRing, Keyboard, Globe, Plug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore, type Theme } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { AISettingsSection } from "./ai-settings-section";
import { KeyboardShortcutsSection } from "./keyboard-shortcuts-section";
import { TelegramSettingsSection } from "./telegram-settings-section";
import { ProxySettingsSection } from "./proxy-settings-section";
import { McpSettingsSection } from "./mcp-settings-section";
import { usePushNotification } from "@/hooks/use-push-notification";

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ElementType }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const pushSupported = "PushManager" in window && "serviceWorker" in navigator;
const isIosNonPwa = /iPhone|iPad/.test(navigator.userAgent) &&
  !window.matchMedia("(display-mode: standalone)").matches;

type SettingsCategory = "ai" | "notifications" | "proxy" | "shortcuts" | "mcp";

const CATEGORIES: { value: SettingsCategory; label: string; subtitle: string; icon: React.ElementType }[] = [
  { value: "ai", label: "AI Provider", subtitle: "Model, execution mode, limits", icon: Bot },
  { value: "notifications", label: "Notifications", subtitle: "Push & Telegram alerts", icon: BellRing },
  { value: "proxy", label: "API Proxy", subtitle: "Expose accounts as Anthropic API", icon: Globe },
  { value: "shortcuts", label: "Keyboard Shortcuts", subtitle: "Customize key bindings", icon: Keyboard },
  { value: "mcp", label: "MCP Servers", subtitle: "Model Context Protocol tools", icon: Plug },
];

export function SettingsTab() {
  const { theme, setTheme, deviceName, setDeviceName, version } = useSettingsStore();
  const { permission, isSubscribed, loading, error: pushError, subscribe, unsubscribe } = usePushNotification();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null);
  const [nameInput, setNameInput] = useState(deviceName ?? "");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nameChanged = nameInput.trim() !== (deviceName ?? "");

  const handleSaveName = useCallback(async () => {
    if (!nameChanged) return;
    setNameSaving(true);
    try {
      await setDeviceName(nameInput);
      setNameSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setNameSaved(false), 2000);
    } finally {
      setNameSaving(false);
    }
  }, [nameInput, nameChanged, setDeviceName]);

  // Detail view for a category
  if (activeCategory) {
    const cat = CATEGORIES.find((c) => c.value === activeCategory)!;
    const Icon = cat.icon;
    return (
      <div className="h-full w-full flex flex-col">
        {/* Detail header with back */}
        <div className="shrink-0 px-2 pt-3 pb-1 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 cursor-pointer shrink-0"
            onClick={() => setActiveCategory(null)}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Icon className="size-4 text-muted-foreground shrink-0" />
          <h2 className="text-sm font-semibold truncate">{cat.label}</h2>
        </div>
        <Separator />
        {/* Detail content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-3">
            {activeCategory === "ai" && <AISettingsSection compact />}
            {activeCategory === "notifications" && <NotificationsContent isSubscribed={isSubscribed} loading={loading} permission={permission} pushError={pushError} subscribe={subscribe} unsubscribe={unsubscribe} />}
            {activeCategory === "proxy" && <ProxySettingsSection />}
            {activeCategory === "shortcuts" && <KeyboardShortcutsSection />}
            {activeCategory === "mcp" && <McpSettingsSection />}
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Main settings list
  return (
    <div className="h-full w-full flex flex-col">
      <div className="shrink-0 px-3 pt-3 pb-1">
        <h2 className="text-sm font-semibold">Settings</h2>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-4">
          {/* Quick: Device Name */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Device Name</h3>
            <div className="flex gap-1.5">
              <Input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); }}
                placeholder="My Device"
                className="h-8 text-xs flex-1"
                maxLength={100}
              />
              <Button
                variant={nameSaved ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs px-3 cursor-pointer"
                disabled={!nameChanged || nameSaving}
                onClick={handleSaveName}
              >
                {nameSaving ? "..." : nameSaved ? <Check className="size-3.5" /> : "Save"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Shown in page title and synced to PPM Cloud.
            </p>
          </section>

          {/* Quick: Theme */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">Theme</h3>
            <div className="flex gap-1.5">
              {THEME_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                return (
                  <Button
                    key={opt.value}
                    variant={theme === opt.value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setTheme(opt.value)}
                    className={cn(
                      "flex-1 gap-1.5 text-xs h-8 cursor-pointer",
                      theme === opt.value && "ring-2 ring-primary",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {opt.label}
                  </Button>
                );
              })}
            </div>
          </section>

          <Separator />

          {/* Category navigation list */}
          <nav className="space-y-1" aria-label="Settings categories">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              return (
                <button
                  key={cat.value}
                  onClick={() => setActiveCategory(cat.value)}
                  className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg hover:bg-accent/50 active:bg-accent transition-colors cursor-pointer text-left group"
                >
                  <div className="size-8 rounded-md bg-muted flex items-center justify-center shrink-0 group-hover:bg-accent">
                    <Icon className="size-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{cat.label}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{cat.subtitle}</p>
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                </button>
              );
            })}
          </nav>

          <Separator />

          {/* About — footer */}
          <section className="space-y-1 pb-2">
            <p className="text-xs text-muted-foreground">
              PPM — Personal Project Manager
            </p>
            <p className="text-[11px] text-muted-foreground">
              A mobile-first web IDE for managing your projects.
            </p>
            {version && (
              <p className="text-[11px] text-muted-foreground tabular-nums">
                Version {version}
              </p>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

/** Notifications detail content — extracted to keep SettingsTab clean */
function NotificationsContent({ isSubscribed, loading, permission, pushError, subscribe, unsubscribe }: {
  isSubscribed: boolean;
  loading: boolean;
  permission: NotificationPermission;
  pushError: string | null;
  subscribe: () => void;
  unsubscribe: () => void;
}) {
  return (
    <div className="space-y-4">
      {/* Push */}
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Push Notifications</h3>
        {!pushSupported ? (
          <p className="text-[11px] text-muted-foreground">
            Push notifications not supported in this browser.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {isSubscribed ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
                <span className="text-xs">Push notifications</span>
              </div>
              <Button
                variant={isSubscribed ? "default" : "outline"}
                size="sm"
                className="h-7 text-xs cursor-pointer"
                disabled={loading || permission === "denied"}
                onClick={() => (isSubscribed ? unsubscribe() : subscribe())}
              >
                {loading ? "..." : isSubscribed ? "On" : "Off"}
              </Button>
            </div>
            {isSubscribed && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs w-full cursor-pointer"
                onClick={() => {
                  new Notification("PPM Test", { body: "Push notifications are working!" });
                }}
              >
                Test notification
              </Button>
            )}
            {pushError && (
              <p className="text-[11px] text-destructive">{pushError}</p>
            )}
            {permission === "denied" && (
              <p className="text-[11px] text-destructive">
                Notifications blocked. Enable in browser settings.
              </p>
            )}
            {isIosNonPwa && (
              <p className="text-[11px] text-muted-foreground">
                On iOS, install PPM to Home Screen for push notifications.
              </p>
            )}
          </div>
        )}
      </section>

      <Separator />

      {/* Telegram */}
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">Telegram</h3>
        <TelegramSettingsSection />
      </section>
    </div>
  );
}
