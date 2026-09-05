import { BellOff, Bug, Circle, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Session actions that do not earn permanent space in the chat toolbar.
 *
 * The toolbar's left zone scrolls once the chat panel gets narrow, so every
 * control pinned on the right competes for the handful of pixels that stay
 * visible. Only the connection indicator earns that spot; infrequent actions
 * live behind this trigger, which is also where future toolbar actions belong.
 */
export function ChatToolbarOverflowMenu({
  hasUnread,
  onToggleUnread,
  onOpenDebug,
}: {
  hasUnread: boolean;
  onToggleUnread: () => void;
  onOpenDebug: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center size-5 rounded text-text-subtle hover:text-text-secondary hover:bg-surface-elevated transition-colors"
          title="More actions"
          aria-label="More actions"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      {/* Anchored above: this toolbar sits at the bottom of the chat pane. */}
      <DropdownMenuContent align="end" side="top" className="min-w-[190px]">
        <DropdownMenuItem onClick={onToggleUnread} className="max-md:py-3">
          {hasUnread ? (
            <>
              <BellOff className="size-3.5 text-warning" /> Mark as read
            </>
          ) : (
            <>
              <Circle className="size-3.5 fill-current text-primary" /> Mark as unread
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenDebug} className="max-md:py-3">
          <Bug className="size-3.5" /> Session debug info
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
