/**
 * The chrome shared by the chat header's usage panels.
 *
 * Both providers' panels answer the same two questions — how much quota is left, and which
 * account should serve this chat — so they are the same panel with a different source of
 * accounts behind them. Keeping the frame here is what stops that from drifting: the Codex
 * panel used to draw its own header and stack its cards vertically, so comparing two
 * accounts meant scrolling past the first, while the Claude panel had had a sideways strip
 * and a fullscreen grid for exactly that reason.
 *
 * Fullscreen lives here rather than in either caller because the layout it switches to is a
 * property of the frame, and the cards only need to be told which shape to take.
 */

import { useState, type ReactNode } from "react";
import { ExternalLink, Maximize2, Minimize2, RefreshCw, X } from "@/lib/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openSettings } from "@/components/settings/open-settings";

export interface UsagePanelShellProps {
  title: string;
  /** A note beside the title — when the numbers were last read, typically. */
  meta?: ReactNode;
  onClose: () => void;
  onReload?: () => void;
  reloading?: boolean;
  /** One strip for anything that went wrong in the panel. Two messages in two places
   *  would be harder to notice, not clearer. */
  error?: string | null;
  onDismissError?: () => void;
  /** How many cards `children` will render. Zero shows `fallback` and hides fullscreen,
   *  which has nothing to lay out. */
  cardCount: number;
  /** The cards, told which shape to take. */
  children: (layout: "strip" | "grid") => ReactNode;
  /** Shown in place of the cards when there are none. */
  fallback?: ReactNode;
  /** Anything below the cards — costs, hints. Hidden in fullscreen, which is for comparing. */
  footer?: ReactNode;
}

export function UsagePanelShell({
  title, meta, onClose, onReload, reloading, error, onDismissError,
  cardCount, children, fallback, footer,
}: UsagePanelShellProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Roughly square, so the cards fill the viewport instead of leaving a long empty column.
  const fsCount = cardCount || 1;
  const fsCols = Math.ceil(Math.sqrt(fsCount));
  const fsRows = Math.ceil(fsCount / fsCols);

  return (
    <div
      className={`relative border-b border-border bg-surface px-3 py-2.5 ${
        isFullscreen
          ? "fixed inset-0 z-50 flex flex-col gap-2.5 overflow-hidden"
          : "space-y-2.5 max-h-[350px] overflow-y-auto"
      }`}
    >
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-text-primary">{title}</span>
          {meta}
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => openSettings("accounts")}
                className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-primary px-1 cursor-pointer"
              >
                Manage accounts <ExternalLink className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Add, remove or rotate accounts</TooltipContent>
          </Tooltip>
          {cardCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setIsFullscreen((v) => !v)}
                  className="text-xs text-text-subtle hover:text-text-primary px-1 cursor-pointer"
                  aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen view"}
                >
                  {isFullscreen ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{isFullscreen ? "Exit fullscreen" : "Fullscreen view"}</TooltipContent>
            </Tooltip>
          )}
          {onReload && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onReload}
                  disabled={reloading}
                  className="text-xs text-text-subtle hover:text-text-primary px-1 disabled:opacity-50 cursor-pointer"
                  aria-label="Refresh usage"
                >
                  <RefreshCw className={`size-3 ${reloading ? "animate-spin" : ""}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">Refresh</TooltipContent>
            </Tooltip>
          )}
          <button
            onClick={() => { setIsFullscreen(false); onClose(); }}
            className="text-xs text-text-subtle hover:text-text-primary px-1 cursor-pointer"
            aria-label="Close usage panel"
          >
            <X className="size-3" />
          </button>
        </div>
      </div>

      {/* The server distinguishes a login it rejected from a provider it could not reach, and
          the difference decides what the user should do. Showing its words verbatim is the
          only way that survives to them. */}
      {error && (
        <div className="shrink-0 flex items-start gap-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 text-[11px] text-error">
          <span className="flex-1">{error}</span>
          {onDismissError && (
            <button
              onClick={onDismissError}
              className="shrink-0 text-error/70 hover:text-error cursor-pointer"
              aria-label="Dismiss"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      )}

      {cardCount > 0 ? (
        <div
          className={isFullscreen
            ? "flex-1 min-h-0 grid gap-2 overflow-hidden"
            // Same classes as AccountCardRow, with the panel's wider padding to clear.
            : "flex gap-2 overflow-x-auto pb-1 -mx-3 px-3 snap-x snap-mandatory scrollbar-thin"}
          style={isFullscreen ? {
            gridTemplateColumns: `repeat(${fsCols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${fsRows}, minmax(0, 1fr))`,
          } : undefined}
        >
          {children(isFullscreen ? "grid" : "strip")}
        </div>
      ) : fallback}

      {footer && !isFullscreen && footer}
    </div>
  );
}
