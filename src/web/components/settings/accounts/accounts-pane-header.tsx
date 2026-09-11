/**
 * The top of an accounts pane: what this provider is, a refresh, and its action buttons.
 *
 * Shared by every provider's pane so the sub-tabs read as one screen. They used to be two
 * different designs — one on shadcn buttons with dialogs, the other on raw buttons with
 * forms inline down the page — and switching tabs looked like switching apps.
 */

import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AccountsPaneHeader({ description, onRefresh, refreshing, disabled, actions }: {
  /** One line on what these accounts are for. */
  description: React.ReactNode;
  onRefresh: () => void;
  refreshing?: boolean;
  disabled?: boolean;
  /** The pane's action buttons, in a wrapping row. */
  actions: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">{description}</p>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 cursor-pointer"
          onClick={onRefresh}
          disabled={disabled || refreshing}
          title="Refresh"
          aria-label="Refresh accounts"
        >
          <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </section>
  );
}

/**
 * An inline result message.
 *
 * One neutral style, dismissible, for both success and failure: a red banner for "export
 * failed" next to a green one for "backup downloaded" made the pane look like a form with
 * validation errors, and the two providers had picked different colours for the same events.
 */
export function AccountsPaneMessage({ message, onDismiss }: {
  message: string | null;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 text-xs p-2 rounded bg-muted" role="status">
      <span className="flex-1">{message}</span>
      <button
        onClick={onDismiss}
        className="shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
        aria-label="Dismiss message"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * The row accounts are laid out in: a sideways scroller, one card per account.
 *
 * Horizontal everywhere — the chat panel and both settings panes — because the point of the
 * list is comparing accounts, and stacked vertically you scroll past one to reach the next.
 * Shared so the three callers cannot end up scrolling in different directions.
 */
export function AccountCardRow({ children }: { children: React.ReactNode }) {
  return (
    // Negative margin then padding: cards scroll edge to edge while still clearing the
    // pane's own padding at rest. Snap so a swipe lands on a card rather than between two.
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 snap-x snap-mandatory scrollbar-thin">
      {children}
    </div>
  );
}

/**
 * The card one account is drawn in.
 *
 * Shared so a Claude row and a Codex row are the same object on screen even though what goes
 * inside them differs.
 */
export function AccountCardShell({ active, flash, dense, children, ...rest }: {
  active?: boolean;
  /** Brief highlight when this account's numbers just changed. */
  flash?: boolean;
  /** Tighter padding, for a card that has to fit a fixed narrow width. */
  dense?: boolean;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={[
        "rounded-md border transition-colors duration-500",
        dense ? "p-2.5 space-y-1.5" : "p-3 space-y-2",
        flash ? "bg-primary/10 border-primary/40" : "",
        active ? "border-primary/30 bg-primary/5" : "border-border/50",
        rest.className ?? "",
      ].filter(Boolean).join(" ")}
    >
      {children}
    </div>
  );
}
