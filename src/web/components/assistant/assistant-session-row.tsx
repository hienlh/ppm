/**
 * One row of the Assistant's session list: the session, its "Telegram" label when a connected
 * chat talks to it, and the menu that puts it on Telegram.
 *
 * The menu is the adaptive one (right-click on a desktop, a long press on a touch screen), so the
 * row's tap still selects the session; `select-none` keeps a long press from starting a text
 * selection under the sheet it opens.
 */
import { Check, Send } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format-date";
import { PROVIDER_LOGOS } from "@/lib/provider-logos";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSub, ContextMenuSubContent,
  ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import type { AssistantTelegramChat } from "@/hooks/use-assistant-telegram-binding";
import type { SessionInfo } from "../../../types/chat";

export function ProviderLogo({ providerId, className }: { providerId: string; className?: string }) {
  const Logo = PROVIDER_LOGOS[providerId];
  return Logo ? <Logo className={cn("shrink-0", className)} /> : null;
}

export function AssistantSessionRow({ session: s, active, onSelect, boundChats, bindableChats, onUseOnTelegram }: {
  session: SessionInfo;
  active: boolean;
  onSelect: (session: SessionInfo) => void;
  /** The connected chats talking to this session. */
  boundChats: AssistantTelegramChat[];
  /** Chats this session may be put on; empty while the bridge is off. */
  bindableChats: AssistantTelegramChat[];
  onUseOnTelegram: (chat: AssistantTelegramChat) => void;
}) {
  const row = (
    <button
      type="button"
      onClick={() => onSelect(s)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex min-h-11 w-full select-none items-center gap-2 px-3 text-left md:min-h-9",
        "hover:bg-surface-elevated active:bg-surface-elevated",
        active && "bg-surface-elevated",
      )}
    >
      <ProviderLogo providerId={s.providerId} className="size-4" />
      <span className="min-w-0 flex-1 truncate text-sm md:text-xs">{s.title || "Untitled session"}</span>
      {boundChats.length > 0 && (
        <span
          className="flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] leading-5 text-text-secondary"
          title={`Telegram: ${boundChats.map((c) => c.name).join(", ")}`}
          data-testid="assistant-session-telegram"
        >
          <Send className="size-3" />
          Telegram
        </span>
      )}
      <span className="shrink-0 text-xs text-text-subtle md:text-[11px]">
        {formatRelativeDate(s.updatedAt ?? s.createdAt)}
      </span>
    </button>
  );
  if (bindableChats.length === 0) return <li>{row}</li>;

  const isOn = (chat: AssistantTelegramChat) => boundChats.some((c) => c.chatId === chat.chatId);
  const only = bindableChats.length === 1 ? bindableChats[0]! : null;
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        {/* `md:` only: below it the content is a bottom sheet, which a width class would shrink. */}
        <ContextMenuContent className="md:w-56">
          {only ? (
            <ContextMenuItem disabled={isOn(only)} onClick={() => onUseOnTelegram(only)}>
              <Send className="size-4" />
              {isOn(only) ? "On Telegram" : "Use on Telegram"}
            </ContextMenuItem>
          ) : (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <Send className="size-4" />
                Use on Telegram
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="md:w-56">
                {bindableChats.map((chat) => (
                  <ContextMenuItem key={chat.chatId} disabled={isOn(chat)} onClick={() => onUseOnTelegram(chat)}>
                    <span className="min-w-0 flex-1 truncate">{chat.name}</span>
                    {isOn(chat) && <Check className="size-4" />}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
