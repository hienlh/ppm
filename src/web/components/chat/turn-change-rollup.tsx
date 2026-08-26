/**
 * Hosts the turn change rollup: the action bar with the pill appended, plus the tray
 * (desktop) or sheet (phone) it opens.
 *
 * Wraps `MessageActionBar` rather than living inside it, because the desktop tray has
 * to render *below* the bar instead of wrapping inside its flex row.
 */
import { useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import { MessageActionBar } from "./message-action-bar";
import { TurnChangePill, changeTotals } from "./turn-change-pill";
import { TurnChangeTray } from "./turn-change-tray";
import { TurnChangeSheet } from "./turn-change-sheet";

export function TurnChangeRollup({ timestamp, content, accountLabel, changes, onJumpToEdit }: {
  timestamp: string;
  content: string;
  accountLabel?: string;
  changes?: TurnFileChange[];
  onJumpToEdit?: (editRef: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const pillRef = useRef<HTMLButtonElement>(null);

  // Without this, closing drops focus to <body> and the next Tab restarts from the
  // top of a very long transcript.
  const close = () => {
    setOpen(false);
    pillRef.current?.focus();
  };

  const bar = (
    <MessageActionBar
      timestamp={timestamp}
      content={content}
      accountLabel={accountLabel}
      className="-mt-1.5"
    >
      {changes && changes.length > 0 && (
        <TurnChangePill
          ref={pillRef}
          count={changes.length}
          totals={changeTotals(changes)}
          open={open}
          onToggle={() => (open ? close() : setOpen(true))}
        />
      )}
    </MessageActionBar>
  );

  if (!changes || changes.length === 0) return bar;

  const jump = (editRef: string) => {
    setOpen(false);
    onJumpToEdit?.(editRef);
  };

  return (
    <>
      {bar}
      {isMobile ? (
        <TurnChangeSheet
          changes={changes}
          totals={changeTotals(changes)}
          open={open}
          onClose={close}
          onJump={onJumpToEdit ?? (() => {})}
        />
      ) : (
        open && <TurnChangeTray changes={changes} onJump={jump} onClose={close} />
      )}
    </>
  );
}
