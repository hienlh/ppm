/**
 * Settings → PPM Assistant → Telegram: the Assistant's own bot, its switch, the chats that may
 * use it and which Assistant session each one talks to.
 *
 * A connected chat is a second window onto one Assistant session — the same conversation PPM
 * shows — so a chat connected here can ask for anything the Assistant can do. Every change still
 * waits for an Allow, but the list is for the user's own chats only, and the bot is kept apart
 * from the Notifications one so alerts never land in a chat that can give orders.
 *
 * Built on the `/api/settings/clawbot*` routes the old PPMBot used (same config key, same bot and
 * connected chats, so nothing has to be set up again), sending only the keys that still mean
 * something there: `enabled`, `show_tool_calls`, `debounce_ms`. The bot token is only ever sent,
 * never read back.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Send, TriangleAlert } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { useAssistantTelegramBinding } from "@/hooks/use-assistant-telegram-binding";
import { useAssistantSessions } from "@/components/assistant/assistant-session-list";
import type { TelegramChatInfo } from "../../../shared/notification-settings";
import type { PPMBotTelegramStatus } from "../../../shared/ppmbot-telegram";
import { SectionHeader, SwitchRow } from "./settings-rows";
import { ConnectCard, TelegramChatList, useTelegramConnect } from "./telegram-connect";
import { TelegramBotTokenField } from "./telegram-bot-token-field";

/** The bridge options the server keeps under `clawbot`. */
export interface AssistantTelegramOptions {
  enabled: boolean;
  show_tool_calls: boolean;
  debounce_ms: number;
}

/** The server's bounds for message grouping. */
export const DEBOUNCE_MAX_MS = 30_000;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function runningNote(status: PPMBotTelegramStatus): string {
  if (status.running) return status.botUsername ? `Answering as @${status.botUsername}` : "Running";
  if (status.enabled) return "Turned on, but not running — check the bot token";
  return "Off";
}

/** A whole number of milliseconds the server accepts, or null. */
export function parseDebounceMs(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value <= DEBOUNCE_MAX_MS ? value : null;
}

export function AssistantTelegramSettings() {
  const [status, setStatus] = useState<PPMBotTelegramStatus | null>(null);
  const [options, setOptions] = useState<AssistantTelegramOptions | null>(null);
  const [debounceText, setDebounceText] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [savingOptions, setSavingOptions] = useState(false);
  const binding = useAssistantTelegramBinding();
  const refreshBinding = binding.refresh;
  const { sessions: assistantSessions } = useAssistantSessions();

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
    let active = true;
    api.get<AssistantTelegramOptions>("/api/settings/clawbot")
      .then((data) => {
        if (!active) return;
        setOptions(data);
        setDebounceText(String(data.debounce_ms));
      })
      .catch((e) => { if (active) setLoadError(errorText(e)); });
    return () => { active = false; };
  }, [load]);

  const { link, starting, connect, cancel } = useTelegramConnect("/api/settings/clawbot/telegram/connect", status, load);

  // The binding route lists only connected chats, so it is re-read whenever that set changes
  // (a link spent, a chat disconnected here or from another browser) — not on every poll.
  const chatIds = status?.chats.map((c) => c.chatId).join(",");
  useEffect(() => {
    if (chatIds !== undefined) void refreshBinding();
  }, [chatIds, refreshBinding]);

  const setEnabled = async (on: boolean) => {
    setSwitching(true);
    // Shown at once; the reload below says what the server made of it.
    setStatus((current) => (current ? { ...current, enabled: on } : current));
    try {
      await api.put("/api/settings/clawbot", { enabled: on });
    } catch (e) {
      toast.error(on ? "Could not turn Telegram on" : "Could not turn Telegram off", { description: errorText(e) });
    } finally {
      setSwitching(false);
      await load();
    }
  };

  /** Saves one or more bridge options; the server answers with all three as stored. */
  const saveOptions = async (patch: Partial<Pick<AssistantTelegramOptions, "show_tool_calls" | "debounce_ms">>) => {
    setSavingOptions(true);
    try {
      const saved = await api.put<AssistantTelegramOptions>("/api/settings/clawbot", patch);
      setOptions(saved);
      setDebounceText(String(saved.debounce_ms));
    } catch (e) {
      toast.error("Could not save", { description: errorText(e) });
      if (options) setDebounceText(String(options.debounce_ms));
    } finally {
      setSavingOptions(false);
    }
  };

  const disconnect = async (chat: TelegramChatInfo) => {
    try {
      await api.del(`/api/settings/clawbot/paired/${encodeURIComponent(chat.chatId)}`);
      toast.success(`Disconnected ${chat.name}`, { description: "It can no longer reach the Assistant." });
    } catch (e) {
      toast.error("Could not disconnect", { description: errorText(e) });
    } finally {
      await load();
    }
  };

  const chats = status?.chats ?? [];
  const debounceMs = parseDebounceMs(debounceText);
  const debounceChanged = !!options && debounceMs !== options.debounce_ms;

  const sessionOf = (chat: TelegramChatInfo): string => {
    const bound = binding.state?.chats.find((c) => c.chatId === chat.chatId);
    if (!bound?.sessionId) return "No session yet — its next message starts one";
    // The server knows only a title the session was renamed to; the list knows the one the
    // provider gave it, which is what the Assistant's own session list shows.
    const title = bound.sessionTitle || assistantSessions.find((s) => s.id === bound.sessionId)?.title;
    return `Talks to “${title || "Untitled session"}”`;
  };

  return (
    <section className="space-y-3" data-testid="assistant-telegram-settings">
      <SectionHeader title="Telegram">
        Talk to the PPM Assistant from Telegram, through a bot of its own. A connected chat shares one
        Assistant session with PPM, and everything it asks to change still waits for your Allow — connect
        only your own chat.
      </SectionHeader>
      {loadError && <p className="text-xs text-error" role="alert">{loadError}</p>}

      {status?.configured && (
        <>
          {status.sharedWithNotifications && (
            <p className="flex gap-2 rounded-lg border border-warning/40 px-3 py-2 text-xs leading-relaxed">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                Notifications use this bot too, so alerts arrive in your Assistant chats. Paste a new bot's token below to give the Assistant its own.
              </span>
            </p>
          )}

          <div className="rounded-lg border border-border">
            <SwitchRow
              label="Use the Assistant on Telegram"
              note={runningNote(status)}
              checked={status.enabled}
              disabled={switching}
              onChange={(on) => void setEnabled(on)}
            />
          </div>

          {chats.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Chats that can use the Assistant</p>
              <TelegramChatList chats={chats} detail={sessionOf} onDisconnect={(chat) => void disconnect(chat)} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                To move a chat to another conversation, send /sessions or /new there, or choose Use on Telegram on a session in the Assistant.
              </p>
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

          {options && (
            <div className="space-y-3 pt-1">
              <div className="rounded-lg border border-border">
                <SwitchRow
                  label="Show tool names"
                  note="A line in the reply naming each tool the Assistant uses. Inputs and outputs are never sent."
                  checked={options.show_tool_calls}
                  disabled={savingOptions}
                  onChange={(on) => void saveOptions({ show_tool_calls: on })}
                />
              </div>
              <form
                className="space-y-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (debounceMs !== null && debounceChanged) void saveOptions({ debounce_ms: debounceMs });
                }}
              >
                <label htmlFor="assistant-telegram-debounce" className="block text-xs text-muted-foreground">Message grouping (ms)</label>
                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                  <Input
                    id="assistant-telegram-debounce"
                    inputMode="numeric"
                    value={debounceText}
                    disabled={savingOptions}
                    onChange={(e) => setDebounceText(e.target.value)}
                    aria-invalid={debounceMs === null}
                    className="h-11 w-full text-sm md:h-8 md:w-32"
                  />
                  {debounceChanged && (
                    <Button type="submit" size="sm" disabled={savingOptions || debounceMs === null} className="min-h-11 cursor-pointer md:min-h-8">
                      {savingOptions ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
                    </Button>
                  )}
                </div>
                <p className={debounceMs === null ? "text-xs text-error" : "text-xs text-muted-foreground"}>
                  {debounceMs === null
                    ? `A whole number from 0 to ${DEBOUNCE_MAX_MS.toLocaleString()}.`
                    : "Messages sent this close together are answered as one. 0 answers each at once."}
                </p>
              </form>
            </div>
          )}
        </>
      )}

      {status && !status.configured && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Create a new bot for the Assistant rather than reusing the one in Settings → Notifications, so alerts stay out of the chats that can give it orders.
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
