/**
 * "Use reset": spend one of Codex's free rate-limit resets on an account — offered only once a
 * limit is actually reached.
 *
 * Rendered nothing at all otherwise, on purpose: a reset is one-use, it moves the weekly reset
 * date (the next weekly reset is counted from when you continue; the original one is not also
 * granted), and spent early it throws away whatever was left of the window. The server applies
 * the same rule (`usageLimitReached`) against a live read, so a stale card cannot slip past it.
 *
 * The confirmation says exactly that before anything is spent. Bottom sheet below `md`,
 * centred dialog above, like every other confirmation in the accounts pane.
 */

import { useState } from "react";
import { Loader2, RotateCcw } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { canUseResetCredit } from "../../../../shared/usage-extra.ts";
import type { LimitBucket, ResetCredits } from "../../../../types/chat";

type Outcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

const OUTCOME_MESSAGE: Record<Outcome, (label: string) => string> = {
  reset: (l) => `${l}: limits reset to 0%. The weekly reset date now counts from your next use.`,
  nothingToReset: (l) => `${l}: nothing needed resetting, so the reset was kept.`,
  noCredit: (l) => `${l} has no free reset left.`,
  alreadyRedeemed: (l) => `${l}: that reset had already been used.`,
};

function when(iso?: string): string | null {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
}

export function CodexResetCreditButton({ account, usage, onDone }: {
  account: { id: string; label: string };
  usage: { session?: LimitBucket; weekly?: LimitBucket; resetCredits?: ResetCredits };
  /** Called after an attempt, with a message saying what happened (or why it was refused). */
  onDone: (message: string) => void;
}) {
  const isMobile = useIsMobile();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!canUseResetCredit(usage)) return null;
  const credits = usage.resetCredits!;

  async function spend() {
    setBusy(true);
    try {
      const r = await api.post<{ outcome: Outcome }>(`/api/codex-accounts/${account.id}/reset-credit`);
      onDone(OUTCOME_MESSAGE[r.outcome]?.(account.label) ?? `${account.label}: ${r.outcome}`);
    } catch (e) {
      onDone((e as Error).message || "Could not use the reset");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const weeklyNow = when(usage.weekly?.resetsAt);
  const expires = when(credits.nextExpiresAt);
  const body = (
    <div className="space-y-3" data-testid="codex-reset-credit-confirm">
      <p className="text-sm">
        Use 1 of <span className="font-medium">{account.label}</span>'s {credits.available} free reset{credits.available === 1 ? "" : "s"}?
      </p>
      <ul className="text-xs text-text-secondary space-y-1.5 list-disc pl-4">
        <li>{credits.title ?? "Full reset"}: the 5-hour and weekly usage go back to 0% now.</li>
        <li>
          The weekly reset date moves: the next one is about 7 days after you continue using Codex
          {weeklyNow ? `, not ${weeklyNow} as now` : ""}. You do not also get that one.
        </li>
        {expires && <li>This spends the reset that expires first ({expires}).</li>}
      </ul>
      <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-1">
        <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy} className="min-h-11">
          Keep it
        </Button>
        <Button onClick={() => void spend()} disabled={busy} className="min-h-11 gap-1.5">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
          Use reset
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="min-h-11 md:min-h-0 md:h-7 gap-1 px-2 text-[11px] cursor-pointer border-primary/40 text-primary"
        onClick={() => setConfirming(true)}
        disabled={busy}
      >
        <RotateCcw className="size-3.5" /> Use reset
      </Button>
      {confirming && (isMobile ? (
        <BottomSheet open onClose={() => { if (!busy) setConfirming(false); }}>
          <div className="px-4 pb-4">
            <h2 className="text-base font-semibold mb-3">Use a free reset</h2>
            {body}
          </div>
        </BottomSheet>
      ) : (
        <Dialog open onOpenChange={(v) => { if (!v && !busy) setConfirming(false); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">Use a free reset</DialogTitle>
            </DialogHeader>
            {body}
          </DialogContent>
        </Dialog>
      ))}
    </>
  );
}
