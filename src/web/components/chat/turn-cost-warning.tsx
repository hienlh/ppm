import { useState } from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import type { TurnUsage } from "../../../shared/turn-usage";
import {
  assessTurnCost,
  fmtTokens,
  prefixCostMultiplier,
  prefixTokens,
} from "../../../shared/turn-usage";

/**
 * Why a turn cost more than the one before it.
 *
 * A session's transcript is replayed to the API every turn, so the bill tracks the cache
 * hit rate on that prefix rather than anything visible in the conversation. When the prefix
 * stops being cached the same message can cost several times more, which is invisible
 * without saying so — hence a notice attached to the turn that paid for it.
 *
 * Only renders for turns worth acting on; a cheap or well-cached turn shows nothing.
 */
export function TurnCostWarning({ usage }: { usage: TurnUsage }) {
  const [open, setOpen] = useState(false);
  const verdict = assessTurnCost(usage);
  if (verdict.level === "ok") return null;

  const multiplier = prefixCostMultiplier(usage);
  const prefix = prefixTokens(usage);
  const hitPct = Math.round(usage.cacheHitRate * 100);
  const isBad = verdict.level === "bad";

  return (
    <div
      className={`rounded-md border px-2.5 py-2 text-[11px] ${
        isBad ? "border-warning/40 bg-warning/10" : "border-border bg-surface"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 py-1 text-left text-text-secondary transition-colors hover:text-text-primary"
      >
        <TriangleAlert
          className={`mt-px size-3.5 shrink-0 ${isBad ? "text-warning" : "text-text-subtle"}`}
        />
        <span className="flex-1">
          Costly turn — {hitPct}% of a {fmtTokens(prefix)}-token transcript came from cache,
          so it cost about{" "}
          <strong className="font-semibold">{multiplier.toFixed(1)}x</strong> a fully cached
          turn.
        </span>
        <ChevronDown
          className={`mt-px size-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
          {verdict.reason && <p className="text-text-secondary">{verdict.reason}</p>}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10.5px] text-text-subtle">
            <Row label="From cache" value={`${fmtTokens(usage.cacheReadTokens)} (${hitPct}%)`} />
            <Row label="Written to cache" value={fmtTokens(usage.cacheWriteTokens)} />
            <Row label="Fresh input" value={fmtTokens(usage.inputTokens)} />
            <Row label="Output" value={fmtTokens(usage.outputTokens)} />
            <Row label="Model" value={usage.model || "unknown"} />
            <Row label="Cost" value={`$${usage.costUsd.toFixed(4)}`} />
          </dl>
          <p className="text-text-subtle">
            A turn stays cached while the session keeps running. Closing the last tab of an idle
            session, switching model, or a retry all restart it, and the next turn re-sends the
            transcript at full price.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="truncate">{label}</dt>
      <dd className="truncate text-right text-text-secondary">{value}</dd>
    </>
  );
}
