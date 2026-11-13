/**
 * Claude's free limit resets on an account card (claude.ai's "Limit resets"): the card lists each
 * kind with its expiry; its "Use" opens a sheet where the person picks which one (a Full reset or a
 * Fable reset) with "Reset for free", or sees Claude Code's reason when Anthropic would not take it now.
 *
 * Spending one asks first: what it refills, and — used before any limit it refills is reached —
 * how much of the window is thrown away. The server re-checks the grant against a live read
 * (`claude-limit-reset.service.ts`), so a stale card cannot spend one Anthropic would refuse.
 */

import { useState } from "react";
import { Loader2, RotateCcw } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  claudeResetBlockedReason,
  claudeResetEarlyWarning,
  claudeResetKindName,
  claudeResetRefills,
  claudeResetResultMessage,
  claudeResetsLeft,
  type ClaudeResetKind,
  type ClaudeResetResult,
} from "../../../../shared/claude-limit-resets.ts";
import type { ClaudeLimitResetGrant, ClaudeLimitResets } from "../../../../types/chat";
import { ResetRow, ResetsSection, ResetsSheet, resetWhen, type ResetLine } from "./account-resets";

/** What using it refills, in a sentence. */
export function grantDescription(g: ClaudeLimitResetGrant): string {
  const back = g.givesBackWeekly ? " and gives back what Fable used of your weekly limit. It doesn't reset your whole week" : "";
  return `Refills your ${claudeResetRefills(g)}${back}. Your weekly reset day stays the same.`;
}

/** One card line per kind and expiry: two Fable grants ending the same day read "Fable reset ×2". */
function cardLines(grants: ClaudeLimitResetGrant[]): ResetLine[] {
  const groups = new Map<string, { kind: ClaudeResetKind; count: number; endsAt?: string }>();
  for (const g of grants) {
    const key = `${g.kind}|${g.endsAt ?? ""}`;
    const group = groups.get(key) ?? { kind: g.kind, count: 0, endsAt: g.endsAt };
    group.count += g.resetsLeft;
    groups.set(key, group);
  }
  return [...groups].map(([key, g]) => ({
    key,
    title: <>{claudeResetKindName(g.kind, true)}{g.count > 1 && <span className="text-text-subtle"> ×{g.count}</span>}</>,
    expiresAt: g.endsAt,
  }));
}

export function ClaudeLimitResetsButton({ account, resets, onDone }: {
  account: { id: string; label: string };
  resets?: ClaudeLimitResets;
  /** Called after an attempt, with a message saying what happened (or why it was refused). */
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<ClaudeLimitResetGrant | null>(null);
  const [busy, setBusy] = useState(false);

  const grants = (resets?.grants ?? []).filter((g) => g.resetsLeft > 0);
  if (!resets || !grants.length) return <ResetsSection count={0} lines={[]} usable={false} onOpen={() => {}} />;
  const blocked = (g: ClaudeLimitResetGrant) => claudeResetBlockedReason(g, resets);

  const close = () => { if (!busy) { setOpen(false); setConfirm(null); } };

  async function spend(grant: ClaudeLimitResetGrant) {
    setBusy(true);
    try {
      const r = await api.post<{ result: ClaudeResetResult; kind: ClaudeResetKind; reason?: string | null; resetsLeft?: number | null; weeklyResetsAt?: string | null }>(
        `/api/accounts/${account.id}/limit-reset`, { grantId: grant.id },
      );
      onDone(claudeResetResultMessage(account.label, r.result, r));
    } catch (e) {
      onDone((e as Error).message || "Could not use the reset");
    } finally {
      setBusy(false);
      setOpen(false);
      setConfirm(null);
    }
  }

  const list = (
    <div className="space-y-2" data-testid="claude-limit-resets">
      {grants.map((g) => (
        <ResetRow
          key={g.id}
          testId={`claude-reset-${g.id}`}
          title={<>{claudeResetKindName(g.kind, true)}{g.resetsLeft > 1 && <span className="text-text-subtle font-normal"> ×{g.resetsLeft}</span>}</>}
          detail={grantDescription(g)}
          expiresAt={g.endsAt}
          action="Reset for free"
          blockedReason={blocked(g)}
          onUse={() => setConfirm(g)}
        />
      ))}
    </div>
  );

  const confirmBody = confirm && (() => {
    const kind = claudeResetKindName(confirm.kind);
    const early = claudeResetEarlyWarning(confirm, resets);
    return (
      <div className="space-y-3" data-testid="claude-limit-reset-confirm">
        <p className="text-sm">Use <span className="font-medium">{account.label}</span>'s {kind}?</p>
        <ul className="text-xs text-text-secondary space-y-1.5 list-disc pl-4">
          <li>{grantDescription(confirm)}</li>
          {early && <li className="text-warning">{early}</li>}
          <li>
            {confirm.resetsLeft > 1 ? `${confirm.resetsLeft} of this kind left` : "The only one of this kind"}
            {confirm.endsAt ? `, use by ${resetWhen(confirm.endsAt)}` : ""}.
          </li>
        </ul>
        <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-1">
          <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy} className="min-h-11">Keep it</Button>
          <Button onClick={() => void spend(confirm)} disabled={busy} className="min-h-11 gap-1.5">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            Yes, use my {kind}
          </Button>
        </div>
      </div>
    );
  })();

  const total = claudeResetsLeft(resets);
  return (
    <>
      <ResetsSection
        count={total}
        lines={cardLines(grants)}
        usable={grants.some((g) => !blocked(g))}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <ResetsSheet title={confirm ? `Use a ${claudeResetKindName(confirm.kind)}?` : `Limit resets · ${total} available`} onClose={close}>
          {confirmBody || list}
        </ResetsSheet>
      )}
    </>
  );
}
