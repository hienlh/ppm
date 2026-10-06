/**
 * Settings → PPMBot → Telegram: PPMBot's own bot, its switch, and the chats that may use
 * it. Laid out like Settings → Notifications → Telegram, with one difference that
 * matters: a chat connected here can command PPMBot, which runs tasks on this machine.
 * That is why the bot is not the notifications one, and why the list is its own.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Send, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { TelegramChatInfo } from "../../../shared/notification-settings";
import type { PPMBotTelegramStatus } from "../../../shared/ppmbot-telegram";
import { SectionHeader, SwitchRow } from "./settings-rows";
import { ConnectCard, TelegramChatList, useTelegramConnect } from "./telegram-connect";
import { TelegramBotTokenField } from "./telegram-bot-token-field";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function runningNote(status: PPMBotTelegramStatus): string {
  if (status.running) return status.botUsername ? `Answering as @${status.botUsername}` : "Running";
  if (status.enabled) return "Turned on, but not running — check the bot token";
  return "Off";
}

export function PPMBotTelegramSection() {
  const [status, setStatus] = useState<PPMBotTelegramStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.get<PPMBotTelegramStatus>("/api/settings/clawbot/telegram");
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

  const { link, starting, connect, cancel } = useTelegramConnect("/api/settings/clawbot/telegram/connect", status, load);

  const setEnabled = async (on: boolean) => {
    setSwitching(true);
    // Shown at once; the reload below says what the server made of it.
    setStatus((current) => (current ? { ...current, enabled: on } : current));
    try {
      await api.put("/api/settings/clawbot", { enabled: on });
    } catch (e) {
      toast.error(on ? "Could not turn PPMBot on" : "Could not turn PPMBot off", { description: errorText(e) });
    } finally {
      setSwitching(false);
      await load();
    }
  };

  const disconnect = async (chat: TelegramChatInfo) => {
    try {
      await api.del(`/api/settings/clawbot/paired/${encodeURIComponent(chat.chatId)}`);
      toast.success(`Disconnected ${chat.name}`, { description: "It can no longer use PPMBot." });
    } catch (e) {
      toast.error("Could not disconnect", { description: errorText(e) });
    } finally {
      await load();
    }
  };

  const chats = status?.chats ?? [];

  return (
    <section className="space-y-3">
      <SectionHeader title="Telegram">
        Chat with PPMBot through a Telegram bot of its own. A chat connected here can run tasks on this machine, so connect only your own.
      </SectionHeader>
      {loadError && <p className="text-xs text-error">{loadError}</p>}

      {status?.configured && (
        <>
          {status.sharedWithNotifications && (
            <p className="flex gap-2 rounded-lg border border-warning/40 px-3 py-2 text-xs leading-relaxed">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                Notifications use this bot too, so alerts arrive in your PPMBot chats. Paste a new bot's token below to give PPMBot its own.
              </span>
            </p>
          )}

          <div className="rounded-lg border border-border">
            <SwitchRow
              label="Turn on PPMBot"
              note={runningNote(status)}
              checked={status.enabled}
              disabled={switching}
              onChange={(on) => void setEnabled(on)}
            />
          </div>

          {chats.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Chats that can use PPMBot</p>
              <TelegramChatList chats={chats} onDisconnect={(chat) => void disconnect(chat)} />
            </div>
          )}

          {link ? (
            <ConnectCard link={link} botUsername={status.botUsername} error={status.connect.error} onCancel={() => void cancel()} />
          ) : (
            <Button onClick={() => void connect()} disabled={starting} className="min-h-11 w-full cursor-pointer gap-2 sm:w-auto md:min-h-9">
              {starting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {chats.length === 0 ? "Connect Telegram" : "Connect another chat"}
            </Button>
          )}
        </>
      )}

      {status && !status.configured && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Create a new bot for PPMBot rather than reusing the one in Settings → Notifications, so alerts stay out of your PPMBot chats.
        </p>
      )}
      {/* After the status loads, so the guide opens for a bot that is not set up and stays shut for one that is. */}
      {status && (
        <TelegramBotTokenField
          endpoint="/api/settings/clawbot/telegram"
          usernameExample="my_ppm_assistant_bot"
          configured={status.configured}
          botUsername={status.botUsername}
          onSaved={() => void load()}
        />
      )}
    </section>
  );
}
