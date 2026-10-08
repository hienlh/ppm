/**
 * Every floating window in one list, opened from the dock's `+N` or a right-click on the
 * dock: search, the open ones and the minimized ones in two groups, a close button per row,
 * and "Minimize all".
 *
 * The close button is revealed on hover only where hovering exists; on a touch screen it is
 * always shown.
 */

import { useState, type RefObject } from "react";
import { Popover } from "radix-ui";
import { Search, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { closeWindow } from "./close-window";
import { useWindowMeta, useWindowSearchText } from "./use-window-meta";
import { windowTitle } from "./window-content-registry";
import { useWindowStore, type WindowRuntimeState } from "./window-store";
import { WindowTile } from "./window-title-identity";

export function WindowDockList({ open, onOpenChange, anchorRef, windows, frontId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  windows: WindowRuntimeState[];
  frontId: string | null;
}) {
  const [query, setQuery] = useState("");
  const shown = windows.filter((w) => w.state !== "minimized");
  const minimized = windows.filter((w) => w.state === "minimized");

  const setOpen = (next: boolean) => {
    if (next) setQuery("");
    onOpenChange(next);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <Popover.Portal>
        <Popover.Content
          aria-label="All windows"
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          // `+N` toggles the list itself: let its click close it rather than the outside
          // press closing it and the click opening it again.
          onPointerDownOutside={(e) => {
            if ((e.target as Element | null)?.closest?.("[data-more]")) e.preventDefault();
          }}
          className="z-50 flex max-h-[min(440px,70vh)] w-[300px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-border bg-panel-2 font-sans shadow-lg"
        >
          <div className="flex items-center gap-2 pb-2 pl-3.5 pr-2.5 pt-2.5">
            <span className="text-[13px] font-semibold text-text">Windows</span>
            <span className="font-mono text-[11px] text-text-3">{windows.length}</span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => { useWindowStore.getState().minimizeAll(); setOpen(false); }}
              className="rounded-md px-1.5 py-1 text-xs font-medium text-primary can-hover:hover:bg-accent-wash"
            >
              Minimize all
            </button>
          </div>
          <label className="mx-2.5 mb-1.5 flex h-[30px] items-center gap-1.5 rounded-lg border border-border-soft bg-panel px-2 text-text-3 focus-within:border-accent-wash-border">
            <Search className="size-3.5 shrink-0" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a window…"
              aria-label="Find a window"
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-text-3"
            />
          </label>
          <WindowRows query={query} shown={shown} minimized={minimized} frontId={frontId} onPicked={() => setOpen(false)} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function WindowRows({ query, shown, minimized, frontId, onPicked }: {
  query: string;
  shown: WindowRuntimeState[];
  minimized: WindowRuntimeState[];
  frontId: string | null;
  onPicked: () => void;
}) {
  const all = [...shown, ...minimized];
  const text = useWindowSearchText(all);
  const q = query.trim().toLowerCase();
  const matching = new Set(all.filter((_, i) => !q || text[i]!.includes(q)).map((w) => w.id));

  const group = (label: string, list: WindowRuntimeState[]) => {
    const rows = list.filter((w) => matching.has(w.id));
    return rows.length > 0 && (
      <>
        <p className="mx-2 mb-1 mt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-3">
          {label} · {rows.length}
        </p>
        {rows.map((w) => <WindowRow key={w.id} win={w} front={w.id === frontId} onPicked={onPicked} />)}
      </>
    );
  };

  return (
    <div className="min-h-0 overflow-y-auto px-1.5 pb-2 pt-0.5">
      {group("Open", shown)}
      {group("Minimized", minimized)}
      {matching.size === 0 && <p className="p-4 text-center text-xs text-text-3">No window matches</p>}
    </div>
  );
}

function WindowRow({ win, front, onPicked }: {
  win: WindowRuntimeState;
  front: boolean;
  onPicked: () => void;
}) {
  const meta = useWindowMeta(win);
  const title = meta.title || windowTitle(win.kind, win.payload);
  const minimized = win.state === "minimized";
  const sub = meta.busy ? `${meta.kindLabel} · working` : front ? `${meta.kindLabel} · in front` : meta.kindLabel;
  return (
    <div className={cn("group relative flex items-center rounded-lg can-hover:hover:bg-surface-hover", front && "bg-accent-wash")}>
      {front && <span aria-hidden="true" className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-[3px] bg-primary" />}
      <button
        type="button"
        onClick={() => { if (!front) useWindowStore.getState().focus(win.id); onPicked(); }}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2.5 pr-2 text-left md:min-h-0"
      >
        <WindowTile icon={meta.icon} tone={meta.tone} size="lg" filled={meta.filled} muted={minimized} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[12.5px] font-medium text-text">{title}</span>
          <span className={cn("truncate text-[11px]", meta.busy ? "text-success" : "text-text-3")}>{sub}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Close ${title}`}
        title="Close"
        onClick={() => closeWindow(win.id)}
        className={cn(
          "mr-1 grid size-[26px] shrink-0 place-items-center rounded-md text-text-3 transition-colors",
          "can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100",
          "can-hover:hover:bg-[color-mix(in_srgb,var(--color-error)_18%,transparent)] can-hover:hover:text-error",
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
