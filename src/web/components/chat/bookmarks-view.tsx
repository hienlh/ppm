/**
 * The chat ··· menu's Bookmarks drill-in: the turns bookmarked in this chat, in turn order. A tap
 * jumps to the turn (opening the history window when it is not loaded); × takes the bookmark off.
 */
import { Bookmark, ChevronLeft, X } from "@/lib/icons";
import { useChatJumpStore } from "@/stores/chat-jump-store";
import { useChatBookmarks, useSessionBookmarks } from "@/stores/session-bookmarks-store";
import { FooterPopoverHeader } from "./footer-popover";

export function BookmarksView({ projectName, sessionId, onBack, onJumped }: {
  projectName: string;
  sessionId: string;
  onBack: () => void;
  onJumped: () => void;
}) {
  const bookmarks = useChatBookmarks(projectName, sessionId);
  const remove = useSessionBookmarks((s) => s.remove);
  return (
    <div className="footer-from-right flex min-h-0 flex-1 flex-col" data-bookmarks-view="">
      <FooterPopoverHeader>
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="-my-1 -ml-1.5 grid size-7 place-items-center rounded-md text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text max-md:size-11"
        >
          <ChevronLeft className="size-3.5 max-md:size-4" />
        </button>
        <b className="text-[13px] font-semibold max-md:text-sm">Bookmarks</b>
      </FooterPopoverHeader>
      {!bookmarks ? (
        <div className="px-3 py-4 text-[12px] text-text-3">Loading…</div>
      ) : bookmarks.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-text-3 max-md:text-sm">
          No bookmarks yet. Bookmark a turn from the bar under any message you sent.
        </div>
      ) : (
        <ul className="max-h-[300px] min-h-0 list-none overflow-y-auto overscroll-contain p-1 max-md:max-h-none max-md:flex-1">
          {bookmarks.map((b) => (
            <li key={b.turnId} className="group flex items-center gap-1" data-bookmark-row={b.turnId}>
              <button
                type="button"
                onClick={() => { useChatJumpStore.getState().jump({ sessionId, turnId: b.turnId }); onJumped(); }}
                className="flex min-h-[34px] min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-[13px] text-text transition-colors can-hover:hover:bg-surface-hover max-md:min-h-11 max-md:text-sm"
              >
                <Bookmark className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">{b.label || "Turn " + (b.turnN ?? "")}</span>
                {b.turnN != null && <span className="shrink-0 text-[11px] tabular-nums text-text-3">Turn {b.turnN}</span>}
              </button>
              <button
                type="button"
                onClick={() => void remove(projectName, sessionId, b.turnId)}
                aria-label="Remove bookmark"
                title="Remove bookmark"
                className="grid size-7 shrink-0 place-items-center rounded-md text-text-3 can-hover:hover:bg-surface-hover can-hover:hover:text-text max-md:size-[26px]"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
