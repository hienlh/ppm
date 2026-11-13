/**
 * Free limit resets on an account card, the same for Claude and Codex: the card lists them with
 * their expiries and no button (`ResetsSection`); its "Use" opens a sheet where one is picked and
 * spent (`ResetsSheet` + `ResetRow`).
 *
 * The provider parts (`claude-limit-resets-button.tsx`, `codex-reset-credit-button.tsx`) decide
 * which reset can be spent and what the confirmation says. Bottom sheet below `md`, centred
 * dialog above, like every other confirmation in the accounts pane.
 */

import type { ReactNode } from "react";
import { ChevronRight } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";

/** "Dec 11, 5:00 AM", with the year when it is not this one. */
export function resetWhen(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit",
  });
}

/** The earliest of these ISO times, if any. */
export function soonest(times: Array<string | undefined>): string | undefined {
  return times.filter((t): t is string => !!t).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

/** "Dec 11", with the year when it is not this one. */
export function resetDay(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Whole days until `iso`, at least 1 while it has not passed. */
export function daysLeft(iso: string, now = Date.now()): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - now) / 86_400_000));
}

/** Within this many days an expiry is drawn as a warning. */
export const EXPIRES_SOON_DAYS = 7;

export interface ResetLine {
  key: string;
  title: ReactNode;
  expiresAt?: string;
}

/**
 * The card's "Free resets" section: how many, and one line per reset (or kind of reset) with its
 * expiry and the days left. Always drawn, "None right now" included, and pushed to the bottom of
 * the card, so cards side by side line up whether or not they hold a reset. "Use" opens the sheet
 * where one is picked; the card itself spends nothing.
 */
export function ResetsSection({ count, lines, usable, onOpen }: {
  count: number;
  lines: ResetLine[];
  /** One of them can be spent right now: "Use" is drawn in the accent colour. */
  usable: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="w-full space-y-1 border-t border-dashed border-border/60 pt-2 text-[11px]" data-testid="resets-section">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">Free resets · {count}</span>
        {count > 0 && (
          <button
            type="button"
            data-testid="resets-use"
            onClick={onOpen}
            className={`-my-3 md:-my-0.5 inline-flex min-h-11 md:min-h-0 items-center gap-0.5 rounded px-1 -mr-1 font-medium cursor-pointer hover:bg-surface-elevated transition-colors ${usable ? "text-primary" : "text-text-secondary"}`}
          >
            Use<ChevronRight className="size-3 shrink-0" aria-hidden />
          </button>
        )}
      </div>
      {lines.length === 0 ? (
        <p className="text-text-subtle">None right now</p>
      ) : lines.map((l) => {
        const days = l.expiresAt ? daysLeft(l.expiresAt) : null;
        const soon = days != null && days <= EXPIRES_SOON_DAYS;
        return (
          <div key={l.key} className="flex items-baseline gap-2" data-testid="reset-line">
            <span className="shrink-0 text-text-secondary">{l.title}</span>
            <span className="min-w-3 flex-1 border-b border-dotted border-border" aria-hidden />
            <span className={`shrink-0 tabular-nums ${soon ? "text-warning" : "text-text-subtle"}`}>
              {l.expiresAt ? `${resetDay(l.expiresAt)} · ${days} day${days === 1 ? "" : "s"}` : "No expiry"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One reset in the sheet: what it is, when it expires, its button or why it has none. */
export function ResetRow({ title, detail, expiresAt, action, blockedReason, onUse, testId }: {
  title: ReactNode;
  detail?: string;
  expiresAt?: string;
  /** The button's label ("Reset for free", "Use reset"). */
  action: string;
  /** Why it cannot be spent now; the button is then disabled. `true` disables it without a line
   *  of its own, for a reason the sheet already states once for every row. */
  blockedReason?: string | true | null;
  onUse: () => void;
  testId?: string;
}) {
  return (
    <div className="rounded-md border border-border/60 p-3 space-y-1" data-testid={testId}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[11px] text-text-subtle">{expiresAt ? `Expires ${resetWhen(expiresAt)}` : "No expiry"}</p>
        </div>
        <Button
          size="sm"
          variant={blockedReason ? "outline" : "default"}
          className="min-h-11 md:min-h-0 md:h-8 shrink-0"
          disabled={!!blockedReason}
          onClick={onUse}
        >
          {action}
        </Button>
      </div>
      {detail && <p className="text-xs text-text-secondary">{detail}</p>}
      {typeof blockedReason === "string" && <p className="text-[11px] text-warning">Can't use it now: {blockedReason}.</p>}
    </div>
  );
}

/** The sheet itself: a dialog on desktop, a bottom sheet on a phone. */
export function ResetsSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const isMobile = useIsMobile();
  return isMobile ? (
    <BottomSheet open onClose={onClose}>
      <div className="px-4 pb-4">
        <h2 className="text-base font-semibold mb-3">{title}</h2>
        {children}
      </div>
    </BottomSheet>
  ) : (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
