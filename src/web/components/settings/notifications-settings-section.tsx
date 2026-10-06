/**
 * Settings → Notifications: what PPM tells you about, when, and where — push to the
 * browsers that turned it on, a Telegram chat with your own bot, and an ntfy topic.
 *
 * "When" and "what" live on the server and apply to every channel. Push is per browser:
 * a browser either holds a subscription or it does not, so the switch is the subscription.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2, Monitor, Send, Smartphone, Trash2 } from "@/lib/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api-client";
import { formatRelativeDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import {
  currentPushSubscription,
  disablePush,
  enablePush,
  pushSupport,
  subscribedWithKey,
  thisDeviceLabel,
} from "@/lib/web-push-client";
import {
  NOTIFICATION_DELAY_OPTIONS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_COPY,
  applyNotificationSettingsPatch,
  type NotificationSettings,
  type NotificationSettingsPatch,
  type NtfyStatus,
  type PushDeviceInfo,
  type PushStatus,
  type TelegramChatInfo,
  type TelegramNotifyStatus,
} from "../../../shared/notification-settings";
import { NtfyServerForm } from "./ntfy-server-form";
import { IconButton, SectionHeader, SwitchRow } from "./settings-rows";
import { ConnectCard, TelegramChatList, useTelegramConnect } from "./telegram-connect";
import { TelegramBotTokenField } from "./telegram-bot-token-field";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ago = (ms: number) => formatRelativeDate(new Date(ms).toISOString());

export function NotificationsSettingsSection() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await api.get<NotificationSettings>("/api/notifications/settings"));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Shown at once; a refused save reloads what the server actually has.
  const update = useCallback(async (patch: NotificationSettingsPatch) => {
    setSettings((current) => (current ? applyNotificationSettingsPatch(current, patch) : current));
    try {
      await api.put("/api/notifications/settings", patch);
    } catch (e) {
      toast.error("Could not save", { description: errorText(e) });
      await load();
    }
  }, [load]);

  if (!settings) {
    return <p className="text-xs text-muted-foreground">{loadError ?? "Loading…"}</p>;
  }

  return (
    <div className="space-y-6">
      <WhenSection settings={settings} update={update} />
      <Separator />
      <PushSection />
      <Separator />
      <TelegramSection settings={settings} update={update} />
      <Separator />
      <NtfySection settings={settings} update={update} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// When and what
// ---------------------------------------------------------------------------

function WhenSection({ settings, update }: {
  settings: NotificationSettings;
  update: (patch: NotificationSettingsPatch) => Promise<void>;
}) {
  const selectId = useId();
  // A delay set through the API may be none of the presets; it must still show as chosen.
  const options = NOTIFICATION_DELAY_OPTIONS.some((o) => o.seconds === settings.delay_seconds)
    ? NOTIFICATION_DELAY_OPTIONS
    : [...NOTIFICATION_DELAY_OPTIONS, { seconds: settings.delay_seconds, label: `After ${settings.delay_seconds} seconds` }];

  return (
    <section className="space-y-3">
      <SectionHeader title="When to notify">For every channel below, on every device.</SectionHeader>
      <div className="space-y-1.5">
        <label htmlFor={selectId} className="text-xs text-muted-foreground">Send a notification</label>
        <select
          id={selectId}
          value={settings.delay_seconds}
          onChange={(e) => void update({ delay_seconds: Number(e.target.value) })}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9"
        >
          {options.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
        </select>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {settings.delay_seconds === 0
            ? "Sent the moment it happens, even while you are looking at the chat."
            : "Sent only if the chat is still unread by then. Opening it in PPM on any device cancels the notification, and so does answering an approval."}
        </p>
      </div>
      <div className="divide-y divide-border rounded-lg border border-border">
        {NOTIFICATION_EVENTS.map((event) => (
          <SwitchRow
            key={event}
            label={NOTIFICATION_EVENT_COPY[event].label}
            note={NOTIFICATION_EVENT_COPY[event].note}
            checked={settings.events[event]}
            onChange={(on) => void update({ events: { [event]: on } })}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

function PushSection() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const support = pushSupport();

  const load = useCallback(async () => {
    try {
      const [next, sub] = await Promise.all([
        api.get<PushStatus>("/api/notifications/push"),
        currentPushSubscription().catch(() => null),
      ]);
      setStatus(next);
      setSubscription(sub);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // On only when the browser's subscription is one the server knows and can still sign for.
  const thisDevice = subscription && status && subscribedWithKey(subscription, status.publicKey)
    ? status.devices.find((d) => d.endpoint === subscription.endpoint) ?? null
    : null;

  // Nothing is awaited before `enablePush`: it must ask for permission inside the click.
  const toggle = async (on: boolean) => {
    if (!status) return;
    setBusy(true);
    try {
      if (on) {
        await enablePush(status.publicKey);
        toast.success("Push is on for this device");
      } else {
        await disablePush();
      }
    } catch (e) {
      toast.error(on ? "Could not turn push on" : "Could not turn push off", { description: errorText(e) });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const test = async (device: PushDeviceInfo) => {
    setTesting(device.id);
    try {
      await api.post("/api/notifications/push/test", { id: device.id });
      toast.success(`Test sent to ${device.label}`);
    } catch (e) {
      toast.error("Test not delivered", { description: errorText(e) });
    } finally {
      setTesting(null);
      await load();
    }
  };

  const remove = async (device: PushDeviceInfo) => {
    if (device.id === thisDevice?.id) return toggle(false);
    try {
      await api.post("/api/notifications/push/unsubscribe", { id: device.id });
    } catch (e) {
      toast.error("Could not remove it", { description: errorText(e) });
    } finally {
      await load();
    }
  };

  const unavailable = support.state === "unavailable" || (support.state === "blocked" && !thisDevice);

  return (
    <section className="space-y-3">
      <SectionHeader title="Push notifications">
        Alerts on this phone or computer, even with PPM closed. Turn it on in each browser that should get them.
      </SectionHeader>

      <div className="rounded-lg border border-border">
        <SwitchRow
          label="This device"
          note={thisDeviceLabel()}
          checked={!!thisDevice}
          disabled={busy || !status || unavailable}
          onChange={(on) => void toggle(on)}
        />
      </div>
      {support.state !== "available" && <p className="text-xs leading-relaxed text-warning">{support.message}</p>}
      {loadError && <p className="text-xs text-error">{loadError}</p>}

      {status && status.devices.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Receiving push</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {status.devices.map((device) => {
              const phone = /Android|iPhone|iPad/.test(device.label);
              const DeviceIcon = phone ? Smartphone : Monitor;
              return (
                <li key={device.id} className="flex items-center gap-3 py-1.5 pl-4 pr-1">
                  <DeviceIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex min-w-0 items-center gap-1.5 text-sm">
                      <span className="truncate">{device.label}</span>
                      {device.id === thisDevice?.id && (
                        <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">This device</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {hostOf(device.origin)} · {device.lastSuccessAt ? `delivered ${ago(device.lastSuccessAt)}` : `added ${ago(device.createdAt)}`}
                    </p>
                    {device.lastError && <p className="break-words text-xs text-error">{device.lastError}</p>}
                  </div>
                  <IconButton label={`Send a test to ${device.label}`} disabled={testing !== null} onClick={() => void test(device)}>
                    {testing === device.id ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  </IconButton>
                  <IconButton label={`Stop push to ${device.label}`} danger disabled={busy} onClick={() => void remove(device)}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function TelegramSection({ settings, update }: {
  settings: NotificationSettings;
  update: (patch: NotificationSettingsPatch) => Promise<void>;
}) {
  const [status, setStatus] = useState<TelegramNotifyStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.get<TelegramNotifyStatus>("/api/notifications/telegram");
      setStatus(next);
      setLoadError(null);
      return next;
    } catch (e) {
      setLoadError(errorText(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { link, starting, connect, cancel } = useTelegramConnect("/api/notifications/telegram/connect", status, load);

  const disconnect = async (chat: TelegramChatInfo) => {
    try {
      await api.del(`/api/notifications/telegram/chats/${encodeURIComponent(chat.chatId)}`);
      toast.success(`Disconnected ${chat.name}`, { description: "It no longer gets alerts." });
    } catch (e) {
      toast.error("Could not disconnect", { description: errorText(e) });
    } finally {
      await load();
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await api.post("/api/settings/telegram/test", {});
      toast.success("Test sent to Telegram");
    } catch (e) {
      toast.error("Test not delivered", { description: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  const chats = status?.chats ?? [];

  return (
    <section className="space-y-3">
      <SectionHeader title="Telegram">
        Alerts in a chat with your own Telegram bot. A chat connected here gets alerts and nothing else — PPMBot has its own bot and chats.
      </SectionHeader>
      {loadError && <p className="text-xs text-error">{loadError}</p>}

      {status?.configured && (
        <>
          {status.sharedWithPPMBot && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              PPMBot answers through this bot too, so alerts arrive in your PPMBot chats. Give PPMBot a bot of its own in Settings → PPMBot to keep them apart.
            </p>
          )}
          <div className="rounded-lg border border-border">
            <SwitchRow
              label="Send notifications to Telegram"
              note={chats.length === 0 ? "No chat connected yet" : chats.length === 1 ? "1 chat connected" : `${chats.length} chats connected`}
              checked={settings.telegram}
              onChange={(on) => void update({ telegram: on })}
            />
          </div>

          <TelegramChatList chats={chats} onDisconnect={(chat) => void disconnect(chat)} />

          {link ? (
            <ConnectCard link={link} botUsername={status.botUsername} error={status.connect.error} onCancel={() => void cancel()} />
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button onClick={() => void connect()} disabled={starting} className="min-h-11 cursor-pointer gap-2 md:min-h-9">
                {starting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {chats.length === 0 ? "Connect Telegram" : "Connect another chat"}
              </Button>
              {chats.length > 0 && (
                <Button variant="outline" onClick={() => void test()} disabled={testing} className="min-h-11 cursor-pointer md:min-h-9">
                  {testing ? "Sending…" : "Send a test"}
                </Button>
              )}
            </div>
          )}
        </>
      )}

      {/* After the status loads, so the guide opens for a bot that is not set up and stays shut for one that is. */}
      {status && (
        <TelegramBotTokenField configured={status.configured} botUsername={status.botUsername} onSaved={() => void load()} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ntfy
// ---------------------------------------------------------------------------

function NtfySection({ settings, update }: {
  settings: NotificationSettings;
  update: (patch: NotificationSettingsPatch) => Promise<void>;
}) {
  const [status, setStatus] = useState<NtfyStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<NtfyStatus>("/api/notifications/ntfy"));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const test = async () => {
    setTesting(true);
    try {
      await api.post("/api/notifications/ntfy/test", {});
      toast.success("Test sent to ntfy");
    } catch (e) {
      toast.error("Test not delivered", { description: errorText(e) });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    try {
      await api.del("/api/notifications/ntfy");
      toast.success("ntfy removed");
    } catch (e) {
      toast.error("Could not remove ntfy", { description: errorText(e) });
    } finally {
      await load();
    }
  };

  return (
    <section className="space-y-3">
      <SectionHeader title="ntfy">
        Alerts through an ntfy server — ntfy.sh or one of your own — on every phone and computer subscribed to your topic.
      </SectionHeader>
      {loadError && <p className="text-xs text-error">{loadError}</p>}

      {status?.configured && (
        <>
          <div className="rounded-lg border border-border">
            <SwitchRow
              label="Send notifications to ntfy"
              note={<>Topic <span className="font-mono">{status.topic}</span> on {hostOf(status.server)}</>}
              checked={settings.ntfy}
              onChange={(on) => void update({ ntfy: on })}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => void test()} disabled={testing} className="min-h-11 cursor-pointer md:min-h-9">
              {testing ? "Sending…" : "Send a test"}
            </Button>
            <a
              href={`${status.server}/${status.topic}`}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: "outline" }), "min-h-11 gap-2 md:min-h-9")}
            >
              Open the topic
              <ExternalLink className="size-3.5" />
            </a>
          </div>
        </>
      )}

      {/* Keyed by what is saved, so a save or a removal starts the form over from it. */}
      {status && (
        <NtfyServerForm key={`${status.server}/${status.topic}`} status={status} onSaved={setStatus} onRemove={() => void remove()} />
      )}
    </section>
  );
}
