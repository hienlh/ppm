/**
 * A card's menu: right-click on a desktop, long press → bottom sheet on a phone (the adaptive
 * menu, which disarms its press on `touchcancel`, so a scroll that starts on a card opens
 * nothing). It holds Reply (the user's own words to the card's manager chat) and, on a phone, the
 * actions that leave the button row there: Open manager chat and Dismiss.
 */
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { cardRefusal, dismissAssistantCard } from "@/lib/assistant-cards-api";
import { applyAssistantCard } from "@/stores/assistant-cards-store";
import { useCardReplyStore } from "@/stores/assistant-card-reply-store";
import {
  DISMISSABLE_CARD_KINDS, MANAGER_REPLY_CARD_KINDS, type AssistantCard,
} from "../../../../shared/assistant-cards";
import { openCardManagerChat } from "./use-card-action";

export interface CardMenuItem {
  label: string;
  run: () => void;
  destructive?: boolean;
}

export function cardMenuItems(card: AssistantCard): CardMenuItem[] {
  const items: CardMenuItem[] = [];
  const hasManager = !!card.sessionId && !!card.projectName;
  if (hasManager && MANAGER_REPLY_CARD_KINDS.includes(card.kind)) {
    items.push({ label: "Reply", run: () => useCardReplyStore.getState().replyTo(card) });
  }
  if (hasManager) items.push({ label: "Open manager chat", run: () => openCardManagerChat(card) });
  if (card.status === "open" && DISMISSABLE_CARD_KINDS.includes(card.kind)) {
    items.push({
      label: "Dismiss",
      destructive: true,
      run: () => {
        dismissAssistantCard(card.id)
          .then((res) => applyAssistantCard(res.card))
          .catch((e) => toast.error(cardRefusal(e).error));
      },
    });
  }
  return items;
}

export function CardMenu({ card, children }: { card: AssistantCard; children: ReactNode }) {
  const items = cardMenuItems(card);
  if (items.length === 0) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-card-menu="">
        {items.map((item) => (
          <ContextMenuItem key={item.label} variant={item.destructive ? "destructive" : "default"} onClick={item.run} className="min-h-11 md:min-h-0">
            {item.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
