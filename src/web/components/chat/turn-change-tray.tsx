/**
 * Desktop presentation of the change tray: an inline, non-modal two-pane panel
 * directly below the message's action bar. Left pane lists the turn's files, right
 * pane shows the selected file's edits.
 *
 * Both panes need `min-h-0` or the grid rows refuse to shrink and neither scrolls.
 */
import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { ownsGlobalShortcut } from "@/lib/owns-global-shortcut";
import type { TurnFileChange } from "@/lib/aggregate-turn-file-changes";
import { ChangeCounts, ChangeFileRow } from "./change-file-row";
import { ChangeEditList } from "./change-edit-list";

function splitPath(path: string): { base: string; dir: string } {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { base: path, dir: "" } : { base: path.slice(i + 1), dir: path.slice(0, i) };
}

/**
 * Several messages in one chat can have a tray open at once, and `ownsGlobalShortcut`
 * only narrows to the focused *tab*. The most recently opened tray claims the keys.
 */
let activeTrayId: string | null = null;

/** `ownsGlobalShortcut` resolves the owning tab; it says nothing about text entry. */
function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function TurnChangeTray({ changes, onJump, onClose }: {
  changes: TurnFileChange[];
  onJump: (editRef: string) => void;
  onClose: () => void;
}) {
  // The desktop tray never shows a bare list — a file is always selected.
  const [selected, setSelected] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const trayId = useId();

  // Inline and non-modal: focus moves in, but is deliberately not trapped.
  useEffect(() => {
    activeTrayId = trayId;
    listRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      if (activeTrayId === trayId) activeTrayId = null;
    };
  }, [trayId]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTrayId !== trayId) return;
      if (!ownsGlobalShortcut(containerRef.current)) return;
      if (isTextEntry(document.activeElement)) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "j") {
        e.preventDefault();
        setSelected((i) => Math.min(i + 1, changes.length - 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setSelected((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        const editRef = changes[selected]?.edits[0]?.editRef;
        if (editRef) {
          e.preventDefault();
          onJump(editRef);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [trayId, changes, selected, onJump, onClose]);

  const active = changes[Math.min(selected, changes.length - 1)];
  if (!active) return null;
  const { base, dir } = splitPath(active.filePath);

  return (
    <div ref={containerRef} className="mt-0.5 overflow-hidden rounded-[10px] border border-border-soft bg-bg">
      <div className="grid h-[356px] grid-cols-[294px_1fr] grid-rows-[minmax(0,1fr)] bg-surface-elevated">
        <div ref={listRef} className="min-h-0 overflow-y-auto border-r border-border-soft">
          {changes.map((change, i) => (
            <ChangeFileRow
              key={change.filePath}
              change={change}
              dense
              selected={i === selected}
              onClick={() => setSelected(i)}
            />
          ))}
          <p className="px-2.5 pt-2 pb-2.5 font-mono text-[10px] text-text-subtle">
            j / k to move · enter to jump
          </p>
        </div>

        <div className="min-h-0 overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-soft bg-surface-elevated py-[5px] pl-2.5 pr-2">
            <span className="shrink-0 font-mono text-xs font-medium text-text-primary">{base}</span>
            {dir && (
              <span
                title={active.filePath}
                className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10.5px] text-text-subtle [direction:rtl] text-left"
              >
                {dir}
              </span>
            )}
            <ChangeCounts
              added={active.linesAdded}
              removed={active.linesRemoved}
              className="shrink-0 font-mono text-[11px]"
            />
            <button
              type="button"
              onClick={() => void copyToClipboard(active.filePath)}
              className="shrink-0 rounded-md px-1.5 py-1 font-mono text-[10px] text-text-subtle transition-colors hover:bg-surface hover:text-text-primary"
            >
              copy path
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close change tray"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-text-subtle transition-colors hover:bg-surface hover:text-text-primary"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <ChangeEditList change={active} onJump={onJump} />
        </div>
      </div>
    </div>
  );
}
