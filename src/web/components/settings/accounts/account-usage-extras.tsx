/**
 * The two usage details that are not one of the fixed buckets, shared by every account card
 * so Settings and the chat panels cannot drift apart:
 *
 * - `ScopedBucketRows` — a model's own weekly limit (Claude's "Fable"), one bar per model,
 *   labelled with the name the provider gives it.
 * - `ResetCreditsChip` — how many free rate-limit resets Codex has granted the account and
 *   when the next one lapses. Spending one is `CodexResetCreditButton`, shown beside it only
 *   once a limit is reached.
 */

import { RotateCcw } from "@/lib/icons";
import type { ResetCredits, ScopedLimitBucket } from "../../../../types/chat";
import { AccountBucketRow } from "./account-bucket-row";
import { AccountHint } from "./account-hint";

export function ScopedBucketRows({ buckets }: { buckets?: ScopedLimitBucket[] }) {
  if (!buckets?.length) return null;
  return <>{buckets.map((b) => <AccountBucketRow key={b.label} label={`Weekly (${b.label})`} bucket={b} />)}</>;
}

/** "3 Nov" — the expiry is weeks out, so the time of day is noise. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function ResetCreditsChip({ credits }: { credits?: ResetCredits }) {
  if (!credits) return null;
  const n = credits.available;
  const label = n === 0 ? "No free resets" : `${n} free reset${n === 1 ? "" : "s"}`;
  const hint = n === 0
    ? "Codex has no free rate-limit resets left for this account."
    : `Codex has granted this account ${n} free rate-limit reset${n === 1 ? "" : "s"}`
      + `${credits.title ? ` (${credits.title})` : ""}.`
      + `${credits.nextExpiresAt ? ` The next one expires on ${new Date(credits.nextExpiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.` : ""}`
      + " A \"Use reset\" button appears here once a limit is reached; a reset moves the weekly reset date, so spending one earlier wastes it.";
  return (
    <AccountHint className={`inline-flex items-center gap-1 ${n > 0 ? "text-primary" : ""}`} hint={hint}>
      <RotateCcw className="size-3 shrink-0" aria-hidden />
      {label}
      {n > 0 && credits.nextExpiresAt && <span className="text-text-subtle">· until {shortDate(credits.nextExpiresAt)}</span>}
    </AccountHint>
  );
}
