/**
 * Codex's free rate-limit resets on an account card: the card lists each with its expiry; its
 * "Use" opens a sheet with "Use reset" on each.
 *
 * A reset is offered only once a limit is actually reached: it is one-use, it moves the weekly
 * reset date (the next weekly reset is counted from when you continue; the original one is not
 * also granted), and spent early it throws away whatever was left of the window. The server
 * applies the same rule (`usageLimitReached`) against a live read, so a stale card cannot slip
 * past it. The confirmation says exactly that before anything is spent.
 */

import { useState } from "react";
import { Loader2, RotateCcw } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { usageLimitReached } from "../../../../shared/usage-extra.ts";
import type { LimitBucket, ResetCredits } from "../../../../types/chat";
import { ResetRow, ResetsSection, ResetsSheet, resetWhen } from "./account-resets";

type Outcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";
type Credit = { id?: string; title?: string; expiresAt?: string };

const OUTCOME_MESSAGE: Record<Outcome, (label: string) => string> = {
  reset: (l) => `${l}: limits reset to 0%. The weekly reset date now counts from your next use.`,
  nothingToReset: (l) => `${l}: nothing needed resetting, so the reset was kept.`,
  noCredit: (l) => `${l} has no free reset left.`,
  alreadyRedeemed: (l) => `${l}: that reset had already been used.`,
};

const NOT_AT_LIMIT = "Usable once a limit is reached: a reset moves the weekly reset date, so spending one earlier wastes what is left of the window.";

/** Each credit, soonest first; an older stored reading has only the count and the soonest. */
function creditList(c: ResetCredits): Credit[] {
  if (c.credits?.length) return c.credits;
  return Array.from({ length: c.available }, (_, i) => (i === 0 ? { id: c.nextCreditId, title: c.title, expiresAt: c.nextExpiresAt } : { title: c.title }));
}

export function CodexResetCreditButton({ account, usage, onDone }: {
  account: { id: string; label: string };
  usage: { session?: LimitBucket; weekly?: LimitBucket; resetCredits?: ResetCredits };
  /** Called after an attempt, with a message saying what happened (or why it was refused). */
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<Credit | null>(null);
  const [busy, setBusy] = useState(false);

  const credits = usage.resetCredits;
  if (!credits || credits.available === 0) return <ResetsSection count={0} lines={[]} usable={false} onOpen={() => {}} />;
  const list = creditList(credits);
  const atLimit = usageLimitReached(usage);

  const close = () => { if (!busy) { setOpen(false); setConfirm(null); } };

  async function spend(credit: Credit) {
    setBusy(true);
    try {
      const r = await api.post<{ outcome: Outcome }>(`/api/codex-accounts/${account.id}/reset-credit`, credit.id ? { creditId: credit.id } : {});
      onDone(OUTCOME_MESSAGE[r.outcome]?.(account.label) ?? `${account.label}: ${r.outcome}`);
    } catch (e) {
      onDone((e as Error).message || "Could not use the reset");
    } finally {
      setBusy(false);
      setOpen(false);
      setConfirm(null);
    }
  }

  const weeklyNow = usage.weekly?.resetsAt ? resetWhen(usage.weekly.resetsAt) : null;
  const confirmBody = confirm && (
    <div className="space-y-3" data-testid="codex-reset-credit-confirm">
      <p className="text-sm">Use 1 of <span className="font-medium">{account.label}</span>'s {credits.available} free reset{credits.available === 1 ? "" : "s"}?</p>
      <ul className="text-xs text-text-secondary space-y-1.5 list-disc pl-4">
        <li>{confirm.title ?? "Full reset"}: the 5-hour and weekly usage go back to 0% now.</li>
        <li>
          The weekly reset date moves: the next one is about 7 days after you continue using Codex
          {weeklyNow ? `, not ${weeklyNow} as now` : ""}. You do not also get that one.
        </li>
        {confirm.expiresAt && <li>This reset expires {resetWhen(confirm.expiresAt)}.</li>}
      </ul>
      <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-1">
        <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy} className="min-h-11">Keep it</Button>
        <Button onClick={() => void spend(confirm)} disabled={busy} className="min-h-11 gap-1.5">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
          Use reset
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <ResetsSection
        count={credits.available}
        lines={list.map((c, i) => ({ key: c.id ?? String(i), title: c.title ?? "Full reset", expiresAt: c.expiresAt }))}
        usable={atLimit}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <ResetsSheet title={confirm ? "Use a free reset" : `Free resets · ${credits.available} available`} onClose={close}>
          {confirmBody || (
            <div className="space-y-2" data-testid="codex-reset-credits">
              {!atLimit && <p className="text-xs text-warning">{NOT_AT_LIMIT}</p>}
              {list.map((c, i) => (
                <ResetRow
                  key={c.id ?? i}
                  title={c.title ?? "Full reset"}
                  detail="Resets the 5-hour and weekly usage to 0%. The weekly reset date then counts from your next use."
                  expiresAt={c.expiresAt}
                  action="Use reset"
                  blockedReason={atLimit ? null : true}
                  onUse={() => setConfirm(c)}
                />
              ))}
            </div>
          )}
        </ResetsSheet>
      )}
    </>
  );
}
