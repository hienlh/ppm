/**
 * Claude's free limit resets on an account card: one button per kind of reset the account holds
 * — "Full reset" (5-hour + weekly), "Fable reset ×2" — so the card says what each one resets
 * without opening anything, as claude.ai lists them under Limit resets.
 *
 * A button opens that kind's confirmation: what it refills, how many are left and until when,
 * and — used before any limit it refills is reached — how much of the window is thrown away.
 * A kind Anthropic would not accept right now opens the same sheet with Claude Code's reason and
 * no way to spend it. The server re-checks the grant against a live read
 * (`claude-limit-reset.service.ts`), so a stale card cannot spend one Anthropic would refuse.
 * Bottom sheet below `md`, centred dialog above, like the Codex reset.
 */

import { useState } from "react";
import { Loader2, RotateCcw } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
  claudeResetEarlyWarning,
  claudeResetGroups,
  claudeResetKindName,
  claudeResetRefills,
  claudeResetResultMessage,
  type ClaudeResetGroup,
  type ClaudeResetKind,
  type ClaudeResetResult,
} from "../../../../shared/claude-limit-resets.ts";
import type { ClaudeLimitResets } from "../../../../types/chat";

function shortWhen(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), hour: "numeric", minute: "2-digit",
  });
}

/** "1 left, use by Dec 11, 5:00 AM" / "2 left, all expire …" / "2 left, first expires …". */
export function groupExpiry(group: ClaudeResetGroup): string {
  const left = `${group.resetsLeft} left`;
  const ends = group.grants.map((g) => g.endsAt).filter((e): e is string => !!e);
  if (!ends.length) return left;
  const first = ends[0]!;
  if (group.resetsLeft <= 1) return `${left}, use by ${shortWhen(first)}`;
  return ends.length === group.grants.length && ends.every((e) => e === first)
    ? `${left}, all expire ${shortWhen(first)}`
    : `${left}, first expires ${shortWhen(first)}`;
}

/** What using one refills, in a sentence. */
export function groupDescription(group: ClaudeResetGroup): string {
  const g = group.target ?? group.grants[0]!;
  const back = g.givesBackWeekly ? " and gives back what Fable used of your weekly limit. It doesn't reset your whole week" : "";
  return `Refills your ${claudeResetRefills(g)}${back}. Your weekly reset day stays the same.`;
}

export function ClaudeLimitResetsButton({ account, resets, onDone }: {
  account: { id: string; label: string };
  resets?: ClaudeLimitResets;
  /** Called after an attempt, with a message saying what happened (or why it was refused). */
  onDone: (message: string) => void;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState<ClaudeResetGroup | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = resets ? claudeResetGroups(resets).filter((g) => g.resetsLeft > 0) : [];
  if (!resets || !groups.length) return null;

  const close = () => { if (!busy) setOpen(null); };

  async function spend(group: ClaudeResetGroup) {
    setBusy(true);
    try {
      const r = await api.post<{ result: ClaudeResetResult; kind: ClaudeResetKind; reason?: string | null; resetsLeft?: number | null; weeklyResetsAt?: string | null }>(
        `/api/accounts/${account.id}/limit-reset`, { grantId: group.target!.id },
      );
      onDone(claudeResetResultMessage(account.label, r.result, r));
    } catch (e) {
      onDone((e as Error).message || "Could not use the reset");
    } finally {
      setBusy(false);
      setOpen(null);
    }
  }

  const body = open && (() => {
    const kind = claudeResetKindName(open.kind);
    const early = open.target ? claudeResetEarlyWarning(open.target, resets) : null;
    return (
      <div className="space-y-3" data-testid="claude-limit-reset-confirm">
        <p className="text-sm">
          {open.target
            ? open.resetsLeft === 1
              ? <>Use <span className="font-medium">{account.label}</span>'s {kind}?</>
              : <>Use 1 of <span className="font-medium">{account.label}</span>'s {open.resetsLeft} {kind}s?</>
            : <><span className="font-medium">{account.label}</span>'s {kind} can't be used right now: {open.blockedReason}.</>}
        </p>
        <ul className="text-xs text-text-secondary space-y-1.5 list-disc pl-4">
          <li>{groupDescription(open)}</li>
          {early && <li className="text-warning">{early}</li>}
          <li>{groupExpiry(open)}.</li>
        </ul>
        <div className="flex flex-col-reverse md:flex-row gap-2 md:justify-end pt-1">
          <Button variant="outline" onClick={close} disabled={busy} className="min-h-11">
            {open.target ? "Keep it" : "Close"}
          </Button>
          {open.target && (
            <Button onClick={() => void spend(open)} disabled={busy} className="min-h-11 gap-1.5">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              Yes, use my {kind}
            </Button>
          )}
        </div>
      </div>
    );
  })();
  const title = open ? (open.target ? `Use a ${claudeResetKindName(open.kind)}?` : claudeResetKindName(open.kind, true)) : "";

  return (
    <>
      {groups.map((group) => (
        <Button
          key={group.kind}
          size="sm"
          variant="outline"
          data-testid={`claude-reset-${group.kind}`}
          className={`min-h-11 md:min-h-0 md:h-7 gap-1 px-2 text-[11px] cursor-pointer ${group.target ? "border-primary/40 text-primary" : "text-text-subtle"}`}
          onClick={() => setOpen(group)}
          title={group.target ? groupDescription(group) : `Can't be used right now: ${group.blockedReason}`}
        >
          <RotateCcw className="size-3.5" />
          {claudeResetKindName(group.kind, true)}
          {group.resetsLeft > 1 && <span className="opacity-70">×{group.resetsLeft}</span>}
        </Button>
      ))}
      {open && (isMobile ? (
        <BottomSheet open onClose={close}>
          <div className="px-4 pb-4">
            <h2 className="text-base font-semibold mb-3">{title}</h2>
            {body}
          </div>
        </BottomSheet>
      ) : (
        <Dialog open onOpenChange={(v) => { if (!v) close(); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-sm">{title}</DialogTitle>
            </DialogHeader>
            {body}
          </DialogContent>
        </Dialog>
      ))}
    </>
  );
}
