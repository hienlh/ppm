/**
 * Phone presentation of the change tray: a modal bottom sheet with push navigation.
 * The file list and a file's edits are separate levels — `‹` pops back to the list
 * rather than closing.
 *
 * The panel is capped; the body scrolls inside it so the sheet itself never does.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, X } from "lucide-react";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { copyToClipboard } from "@/lib/clipboard";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import { ChangeCounts, ChangeFileRow } from "./change-file-row";
import { ChangeEditList } from "./change-edit-list";

function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

/** 44×44 icon control — the minimum touch target on a coarse pointer. */
function IconButton({ label, onClick, children }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-text-subtle transition-colors hover:bg-surface hover:text-text-primary"
    >
      {children}
    </button>
  );
}

export function TurnChangeSheet({ changes, totals, open, onClose, onJump }: {
  changes: TurnFileChange[];
  totals: { added: number; removed: number };
  open: boolean;
  onClose: () => void;
  onJump: (editRef: string) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const active = selected == null ? null : changes[selected];
  const panelRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setSelected(null);
    onClose();
  };

  const jump = (editRef: string) => {
    close();
    onJump(editRef);
  };

  // Modal on phone: focus moves in and stays in. `BottomSheet` handles the scrim and
  // swipe-to-dismiss but not the keyboard, so Escape and the tab cycle live here.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
    focusables()[0]?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <BottomSheet
      open={open}
      onClose={close}
      className="flex max-h-[85%] flex-col rounded-t-[14px] motion-reduce:animate-none"
    >
      <div ref={panelRef} className="flex min-h-0 flex-1 flex-col">
        {active ? (
          <>
            <div className="flex items-center gap-1 border-b border-border-soft px-1 pb-1">
              <IconButton label="Back to file list" onClick={() => setSelected(null)}>
                <ChevronLeft className="size-4" />
              </IconButton>
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-text-primary">
                {basenameOf(active.filePath)}
              </span>
              <ChangeCounts
                added={active.linesAdded}
                removed={active.linesRemoved}
                className="shrink-0 font-mono text-[11px]"
              />
              <IconButton label="Close" onClick={close}>
                <X className="size-4" />
              </IconButton>
            </div>

            <div className="flex items-center gap-1 border-b border-border-soft py-1.5 pl-3 pr-2">
              <span
                title={active.filePath}
                className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10.5px] text-text-subtle [direction:rtl] text-left"
              >
                {active.filePath}
              </span>
              <button
                type="button"
                onClick={() => void copyToClipboard(active.filePath)}
                className="inline-flex min-h-11 shrink-0 items-center rounded-md px-2.5 font-mono text-[10px] text-text-subtle transition-colors hover:bg-surface hover:text-text-primary"
              >
                copy
              </button>
              {active.edits[0]?.editRef && (
                <button
                  type="button"
                  onClick={() => jump(active.edits[0]!.editRef!)}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2.5 font-mono text-[10px] text-text-subtle transition-colors hover:bg-surface hover:text-primary"
                >
                  <ArrowUp className="size-3" />
                  card
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <ChangeEditList change={active} onJump={jump} />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border-soft px-3 pb-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-text-primary">
                Changed this turn · {changes.length} file{changes.length !== 1 ? "s" : ""}
              </span>
              <ChangeCounts
                added={totals.added}
                removed={totals.removed}
                className="shrink-0 font-mono text-[11px]"
              />
              <IconButton label="Close" onClick={close}>
                <X className="size-4" />
              </IconButton>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {changes.map((change, i) => (
                <ChangeFileRow
                  key={change.filePath}
                  change={change}
                  onClick={() => setSelected(i)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
