/**
 * One row of the Assistant's session list in Settings: the session, a "Main" label on the one
 * Telegram follows, a "Telegram" label when a connected chat talks to it, and its menu — Open,
 * Set as main session (Claude only), Use on Telegram, Delete.
 *
 * The menu is the adaptive one (right-click on a desktop, a long press on a touch screen), so the
 * row's tap still opens the session; `select-none` keeps a long press from starting a text
 * selection under the sheet it opens.
 */
import { Check, ExternalLink, Pin, Send, Trash2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format-date";
import { PROVIDER_LOGOS } from "@/lib/provider-logos";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent,
  ContextMenuSubTrigger, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import type { AssistantTelegramChat } from "@/hooks/use-assistant-telegram-binding";
import type { SessionInfo } from "../../../../types/chat";

export function ProviderLogo({ providerId, className }: { providerId: string; className?: string }) {
  const Logo = PROVIDER_LOGOS[providerId];
  return Logo ? <Logo className={cn("shrink-0", className)} /> : null;
}

export interface AssistantSessionRowProps {
  session: SessionInfo;
  isMain: boolean;
  /** Only a Claude session may be the main one for now. */
  canBeMain: boolean;
  onOpen: (session: SessionInfo) => void;
  onSetMain: (session: SessionInfo) => void;
  onDelete: (session: SessionInfo) => void;
  /** The connected chats talking to this session. */
  boundChats: AssistantTelegramChat[];
  /** Chats this session may be put on; empty while the bridge is off. */
  bindableChats: AssistantTelegramChat[];
  onUseOnTelegram: (chat: AssistantTelegramChat) => void;
}

const LABEL = "flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] leading-5 text-text-secondary";

export function AssistantSessionRow(props: AssistantSessionRowProps) {
  const { session: s, isMain, canBeMain, onOpen, onSetMain, onDelete, boundChats, bindableChats, onUseOnTelegram } = props;
  const isOn = (chat: AssistantTelegramChat) => boundChats.some((c) => c.chatId === chat.chatId);
  const only = bindableChats.length === 1 ? bindableChats[0]! : null;
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => onOpen(s)}
            aria-current={isMain ? "true" : undefined}
            className="flex min-h-11 w-full select-none items-center gap-2 px-3 text-left hover:bg-surface-elevated active:bg-surface-elevated md:min-h-9"
          >
            <ProviderLogo providerId={s.providerId} className="size-4" />
            <span className="min-w-0 flex-1 truncate text-sm md:text-xs">{s.title || "Untitled session"}</span>
            {isMain && <span className={cn(LABEL, "border-primary/40 text-primary")} data-testid="assistant-session-main"><Pin className="size-3" />Main</span>}
            {boundChats.length > 0 && (
              <span className={LABEL} title={`Telegram: ${boundChats.map((c) => c.name).join(", ")}`} data-testid="assistant-session-telegram">
                <Send className="size-3" />
                Telegram
              </span>
            )}
            <span className="shrink-0 text-xs text-text-subtle md:text-[11px]">{formatRelativeDate(s.updatedAt ?? s.createdAt)}</span>
          </button>
        </ContextMenuTrigger>
        {/* `md:` only: below it the content is a bottom sheet, which a width class would shrink. */}
        <ContextMenuContent className="md:w-56">
          <ContextMenuItem onClick={() => onOpen(s)}><ExternalLink className="size-4" />Open</ContextMenuItem>
          {canBeMain && !isMain && (
            <ContextMenuItem onClick={() => onSetMain(s)}><Pin className="size-4" />Set as main session</ContextMenuItem>
          )}
          {only && (
            <ContextMenuItem disabled={isOn(only)} onClick={() => onUseOnTelegram(only)}>
              <Send className="size-4" />
              {isOn(only) ? "On Telegram" : "Use on Telegram"}
            </ContextMenuItem>
          )}
          {bindableChats.length > 1 && (
            <ContextMenuSub>
              <ContextMenuSubTrigger><Send className="size-4" />Use on Telegram</ContextMenuSubTrigger>
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
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => onDelete(s)}><Trash2 className="size-4" />Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
