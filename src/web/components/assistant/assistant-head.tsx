/**
 * The Assistant's own head where no window titlebar carries it — the full-screen tab on a phone,
 * or the tab docked into a desktop grid: its name, "Telegram" while the shown session is the one
 * a Telegram chat talks to, the "quiet while I'm at PPM" bell and the settings gear (44 px on a phone).
 */
import { Bot, Send, Settings } from "@/lib/icons";
import { openSettings } from "@/components/settings/open-settings";
import { useAssistantTelegramBinding } from "@/hooks/use-assistant-telegram-binding";
import { ASSISTANT_SETTINGS_LABEL } from "./assistant-title-extras";
import { useAssistantShortName } from "@/stores/assistant-name-store";
import { TelegramQuietHeadButton } from "./telegram-quiet-button";
import { AssistantModeHeadButton } from "./assistant-mode-button";

export function AssistantHead({ sessionId }: { sessionId: string | null }) {
  const { chatsOn } = useAssistantTelegramBinding();
  const onTelegram = !!sessionId && chatsOn(sessionId).length > 0;
  const name = useAssistantShortName();
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border pl-3.5 pr-1.5 md:h-10" data-assistant-head="">
      <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-accent-2 text-primary-foreground">
        <Bot className="size-3.5" />
      </span>
      <span className="min-w-0 truncate text-[13px] font-semibold" data-assistant-name="">{name}</span>
      {onTelegram && (
        <span className="inline-flex items-center gap-1 text-[11px] text-info" data-telegram-label="">
          <Send className="size-3" />Telegram
        </span>
      )}
      <span className="ml-auto" />
      <AssistantModeHeadButton />
      <TelegramQuietHeadButton />
      <button
        type="button"
        onClick={() => openSettings("assistant")}
        aria-label={ASSISTANT_SETTINGS_LABEL}
        title={ASSISTANT_SETTINGS_LABEL}
        className="grid size-11 place-items-center rounded-lg text-text-secondary hover:bg-surface-elevated md:size-8"
      >
        <Settings className="size-[18px] md:size-4" />
      </button>
    </div>
  );
}
