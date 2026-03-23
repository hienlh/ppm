import { useState, useCallback, useRef } from "react";
import {
  Moon, Sun, Monitor, Bell, BellOff, Check,
  Settings2, Bot, BellRing, Users, Keyboard, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore, type Theme } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { AISettingsSection } from "./ai-settings-section";
import { KeyboardShortcutsSection } from "./keyboard-shortcuts-section";
import { TelegramSettingsSection } from "./telegram-settings-section";
import { AccountsSettingsSection } from "./accounts-settings-section";
import { usePushNotification } from "@/hooks/use-push-notification";

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ElementType }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const pushSupported = "PushManager" in window && "serviceWorker" in navigator;
const isIosNonPwa = /iPhone|iPad/.test(navigator.userAgent) &&
  !window.matchMedia("(display-mode: standalone)").matches;

type SettingsCategory = "general" | "ai" | "notifications" | "accounts" | "shortcuts";

const CATEGORIES: { value: SettingsCategory; label: string; icon: React.ElementType }[] = [
  { value: "general", label: "General", icon: Settings2 },
  { value: "ai", label: "AI", icon: Bot },
  { value: "notifications", label: "Notifs", icon: BellRing },
  { value: "accounts", label: "Accounts", icon: Users },
  { value: "shortcuts", label: "Keys", icon: Keyboard },
];

export function SettingsTab() {
  const { theme, setTheme, deviceName, setDeviceName, version } = useSettingsStore();
  const { permission, isSubscribed, loading, error: pushError, subscribe, unsubscribe } = usePushNotification();
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

  return (
    <div className="h-full w-full flex flex-col">
      <Tabs defaultValue="general" className="flex-1 flex flex-col min-h-0">
        {/* Category tab bar — horizontally scrollable */}
        <div className="shrink-0 px-3 pt-3 pb-1">
          <h2 className="text-sm font-semibold mb-2">Settings</h2>
          <TabsList className="w-full h-8 p-0.5 bg-muted rounded-md">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              return (
                <TabsTrigger
                  key={cat.value}
                  value={cat.value}
                  className="flex-1 gap-1 text-[11px] h-7 px-1.5 cursor-pointer data-[state=active]:text-foreground"
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="hidden sm:inline">{cat.label}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        {/* Tab content — scrollable */}
        <div className="flex-1 min-h-0">
          {/* General */}
          <TabsContent value="general" className="h-full m-0">
            <ScrollArea className="h-full">
              <div className="p-3 space-y-4">
                {/* Device Name */}
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

                <Separator />

                {/* Theme */}
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

                {/* About */}
                <section className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Info className="size-3.5 text-muted-foreground" />
                    <h3 className="text-xs font-medium text-muted-foreground">About</h3>
                  </div>
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
          </TabsContent>

          {/* AI */}
          <TabsContent value="ai" className="h-full m-0">
            <ScrollArea className="h-full">
              <div className="p-3">
                <AISettingsSection compact />
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Notifications */}
          <TabsContent value="notifications" className="h-full m-0">
            <ScrollArea className="h-full">
              <div className="p-3 space-y-4">
                {/* Push notifications */}
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
            </ScrollArea>
          </TabsContent>

          {/* Accounts */}
          <TabsContent value="accounts" className="h-full m-0">
            <ScrollArea className="h-full">
              <div className="p-3">
                <AccountsSettingsSection />
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Keyboard Shortcuts */}
          <TabsContent value="shortcuts" className="h-full m-0">
            <ScrollArea className="h-full">
              <div className="p-3">
                <KeyboardShortcutsSection />
              </div>
            </ScrollArea>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
