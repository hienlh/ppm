import { useState, useCallback, useRef } from "react";
import { Moon, Sun, Monitor, Bell, BellOff, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
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

export function SettingsTab() {
  const { theme, setTheme, deviceName, setDeviceName } = useSettingsStore();
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
    <div className="h-full w-full overflow-auto">
      <div className="p-3 space-y-2">
        <h2 className="text-sm font-semibold">Settings</h2>

        <Accordion type="multiple" defaultValue={["device", "notifications"]}>
          {/* Device Name */}
          <AccordionItem value="device">
            <AccordionTrigger className="py-2 text-xs font-medium text-text-secondary hover:no-underline">
              Device Name
            </AccordionTrigger>
            <AccordionContent className="pb-2">
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
                  className="h-8 text-xs px-3"
                  disabled={!nameChanged || nameSaving}
                  onClick={handleSaveName}
                >
                  {nameSaving ? "..." : nameSaved ? <Check className="size-3.5" /> : "Save"}
                </Button>
              </div>
              <p className="text-[11px] text-text-subtle mt-1">
                Shown in page title and synced to PPM Cloud.
              </p>
            </AccordionContent>
          </AccordionItem>

          {/* Theme */}
          <AccordionItem value="theme">
            <AccordionTrigger className="py-2 text-xs font-medium text-text-secondary hover:no-underline">
              Theme
            </AccordionTrigger>
            <AccordionContent className="pb-2">
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
                        "flex-1 gap-1.5 text-xs h-8",
                        theme === opt.value && "ring-2 ring-primary",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {opt.label}
                    </Button>
                  );
                })}
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* AI Settings */}
          <AccordionItem value="ai">
            <AccordionTrigger className="py-2 text-xs font-medium text-text-secondary hover:no-underline">
              AI Settings
            </AccordionTrigger>
            <AccordionContent className="pb-2">
              <AISettingsSection />
            </AccordionContent>
          </AccordionItem>

          {/* Notifications */}
          <AccordionItem value="notifications">
            <AccordionTrigger className="py-2 text-xs font-medium text-text-secondary hover:no-underline">
              Notifications
            </AccordionTrigger>
            <AccordionContent className="pb-2">
              <div className="space-y-2">
                {/* Push notifications */}
                {!pushSupported ? (
                  <p className="text-xs text-text-subtle">
                    Push notifications not supported in this browser.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        {isSubscribed ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
                        <span className="text-xs">Push notifications</span>
                      </div>
                      <Button
                        variant={isSubscribed ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-xs"
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
                        className="h-7 text-xs w-full"
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
                      <p className="text-[11px] text-text-subtle">
                        On iOS, install PPM to Home Screen for push notifications.
                      </p>
                    )}
                  </>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Telegram */}
          <AccordionItem value="telegram">
            <AccordionTrigger className="py-2 text-xs font-medium text-text-secondary hover:no-underline">
              Telegram
            </AccordionTrigger>
            <AccordionContent className="pb-2">
              <TelegramSettingsSection />
            </AccordionContent>
          </AccordionItem>

          {/* Accounts */}
          <AccordionItem value="accounts">
            <AccordionTrigger className="py-2 text-xs font-medium text-text-secondary hover:no-underline">
              Accounts
            </AccordionTrigger>
            <AccordionContent className="pb-2">
              <AccountsSettingsSection />
            </AccordionContent>
          </AccordionItem>

          {/* Keyboard Shortcuts */}
          <AccordionItem value="shortcuts">
            <AccordionTrigger className="py-2 text-xs font-medium text-text-secondary hover:no-underline">
              Keyboard Shortcuts
            </AccordionTrigger>
            <AccordionContent className="pb-2">
              <KeyboardShortcutsSection />
            </AccordionContent>
          </AccordionItem>

          {/* About */}
          <AccordionItem value="about">
            <AccordionTrigger className="py-2 text-xs font-medium text-text-secondary hover:no-underline">
              About
            </AccordionTrigger>
            <AccordionContent className="pb-2">
              <div className="space-y-1.5">
                <p className="text-xs text-text-secondary">
                  PPM — Personal Project Manager
                </p>
                <p className="text-[11px] text-text-subtle">
                  A mobile-first web IDE for managing your projects.
                </p>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );
}
