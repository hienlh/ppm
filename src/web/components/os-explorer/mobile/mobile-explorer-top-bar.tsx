/**
 * Mobile sheet header: the current folder's name, which turns into a path field on a tap, the
 * close button, and under them the path as a row of chips, one per folder on the way.
 *
 * Every frequent action still lives in the bottom toolbar (the thumb zone). Going to a path is
 * the exception that belongs up here: the field is where the path is shown, and a pasted path
 * (`D:\tiktok\story`, `~/Projects`) is the fastest way to a deep folder a phone has.
 *
 * The close button stays: a sheet that fills the whole screen leaves no backdrop to tap, so
 * swipe-to-dismiss would otherwise be the only way out.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowRight, PencilLine, X } from "@/lib/icons";
import { PHONE_ICON_CONTROL_SIZE } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import type { ExplorerSlice } from "../explorer-store";
import type { ExplorerNavigation } from "../use-explorer-navigation";
import { useTypedPath } from "../use-typed-path";
import { MobilePathBreadcrumb } from "./mobile-path-breadcrumb";

export interface MobileExplorerTopBarProps {
  windowId: string;
  slice: ExplorerSlice;
  nav: ExplorerNavigation;
  onClose(): void;
}

/** The folder name to show for the current path — the last breadcrumb is the folder itself. */
function currentFolderName(slice: ExplorerSlice): string {
  const last = slice.breadcrumbs[slice.breadcrumbs.length - 1];
  return last?.name ?? slice.path;
}

/** The app's small icon button (`control-size.ts`: 24px, 22px below `md`). */
const ICON_BUTTON = cn(
  "flex size-6 shrink-0 items-center justify-center rounded-full text-text-2 active:bg-surface-elevated disabled:opacity-50",
  PHONE_ICON_CONTROL_SIZE,
);

export function MobileExplorerTopBar({ windowId, slice, nav, onClose }: MobileExplorerTopBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slice.path);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typed = useTypedPath(windowId, nav);

  useEffect(() => { if (!editing) setDraft(slice.path); }, [slice.path, editing]);
  useEffect(() => {
    if (!editing) return;
    // Selected whole, so a paste replaces the path rather than landing inside it.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const stop = () => { setEditing(false); setError(null); setDraft(slice.path); };
  const go = async () => {
    const answer = await typed.submit(draft);
    if (answer) setError(answer);
    else { setEditing(false); setError(null); }
  };

  return (
    <div className="shrink-0 border-b border-border">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
        {editing ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1"
            onSubmit={(e) => { e.preventDefault(); void go(); }}
          >
            {/* 16px text: iOS zooms the whole page into any field set smaller. */}
            <input
              ref={inputRef}
              aria-label="Path"
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") stop(); }}
              enterKeyHint="go"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              className={cn(
                "h-8 min-w-0 flex-1 rounded-md border bg-panel px-2 font-mono text-base text-text outline-none",
                error ? "border-error" : "border-border focus:border-primary",
              )}
            />
            <button type="submit" aria-label="Go to path" title="Go" disabled={typed.pending} className={ICON_BUTTON}>
              <ArrowRight className="size-4" />
            </button>
            <button type="button" aria-label="Cancel editing the path" title="Cancel" onClick={stop} className={ICON_BUTTON}>
              <X className="size-4" />
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              aria-label={`Edit path: ${slice.path}`}
              title="Edit path"
              onClick={() => setEditing(true)}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left active:bg-surface-elevated"
            >
              <span className="min-w-0 truncate text-[15px] font-semibold text-text">{currentFolderName(slice)}</span>
              <PencilLine className="size-3.5 shrink-0 text-text-subtle" />
            </button>
            <button type="button" aria-label="Close file explorer" title="Close" onClick={onClose} className={ICON_BUTTON}>
              <X className="size-4" />
            </button>
          </>
        )}
      </div>
      {editing && error && (
        <p role="alert" className="px-3 pb-1 text-xs text-error">{error}</p>
      )}
      <MobilePathBreadcrumb crumbs={slice.breadcrumbs} onNavigate={nav.go} />
    </div>
  );
}
