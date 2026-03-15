import { Activity, RefreshCw } from "lucide-react";
import type { UsageInfo, LimitBucket } from "../../../types/chat";

interface UsageBadgeProps {
  usage: UsageInfo;
  onClick?: () => void;
}

function pctColor(pct: number): string {
  if (pct >= 90) return "text-red-500";
  if (pct >= 70) return "text-amber-500";
  return "text-green-500";
}

function barColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-green-500";
}

export function UsageBadge({ usage, onClick }: UsageBadgeProps) {
  const fiveHourPct = usage.fiveHour != null ? Math.round(usage.fiveHour * 100) : null;
  const sevenDayPct = usage.sevenDay != null ? Math.round(usage.sevenDay * 100) : null;

  const fiveHourLabel = fiveHourPct != null ? `${fiveHourPct}%` : "--%";
  const sevenDayLabel = sevenDayPct != null ? `${sevenDayPct}%` : "--%";

  const worstPct = Math.max(fiveHourPct ?? 0, sevenDayPct ?? 0);
  const colorClass = fiveHourPct != null || sevenDayPct != null ? pctColor(worstPct) : "text-text-subtle";

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium tabular-nums transition-colors hover:bg-surface-hover ${colorClass}`}
      title="Click for usage details"
    >
      <Activity className="size-3" />
      <span>5h:{fiveHourLabel}</span>
      <span className="text-text-subtle">·</span>
      <span>Wk:{sevenDayLabel}</span>
    </button>
  );
}

// --- Detail panel ---

interface UsageDetailPanelProps {
  usage: UsageInfo;
  visible: boolean;
  onClose: () => void;
  onReload?: () => void;
  loading?: boolean;
}

function formatResetTime(bucket?: LimitBucket): string | null {
  if (!bucket) return null;
  // Compute total minutes from whichever field is available
  let totalMins: number | null = null;
  if (bucket.resetsInMinutes != null) {
    totalMins = bucket.resetsInMinutes;
  } else if (bucket.resetsInHours != null) {
    totalMins = Math.round(bucket.resetsInHours * 60);
  } else if (bucket.resetsAt) {
    const diff = new Date(bucket.resetsAt).getTime() - Date.now();
    totalMins = diff > 0 ? Math.ceil(diff / 60_000) : 0;
  }
  if (totalMins == null) return null;
  if (totalMins <= 0) return "now";
  const d = Math.floor(totalMins / 1440);
  const h = Math.floor((totalMins % 1440) / 60);
  const m = totalMins % 60;
  if (d > 0) return m > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function statusLabel(status?: string): { text: string; color: string } | null {
  if (!status) return null;
  switch (status) {
    case "ahead_of_pace": return { text: "Ahead of pace", color: "text-green-500" };
    case "behind_pace": return { text: "Behind pace", color: "text-amber-500" };
    case "on_pace": return { text: "On pace", color: "text-text-subtle" };
    default: return { text: status.replace(/_/g, " "), color: "text-text-subtle" };
  }
}

function BucketRow({ label, bucket }: { label: string; bucket?: LimitBucket }) {
  if (!bucket) return null;
  const pct = Math.round(bucket.utilization * 100);
  const reset = formatResetTime(bucket);
  const status = statusLabel(bucket.status);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-primary">{label}</span>
        <div className="flex items-center gap-2">
          {status && (
            <span className={`text-[10px] ${status.color}`}>{status.text}</span>
          )}
          {reset && (
            <span className="text-[10px] text-text-subtle">↻ {reset}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-border overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${barColor(pct)}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <span className={`text-xs font-medium tabular-nums w-10 text-right ${pctColor(pct)}`}>
          {pct}%
        </span>
      </div>
    </div>
  );
}

export function UsageDetailPanel({ usage, visible, onClose, onReload, loading }: UsageDetailPanelProps) {
  if (!visible) return null;

  const hasCost = usage.queryCostUsd != null || usage.totalCostUsd != null;
  const hasBuckets = usage.session || usage.weekly || usage.weeklyOpus || usage.weeklySonnet;

  return (
    <div className="border-b border-border bg-surface px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-text-primary">Usage Limits</span>
        <div className="flex items-center gap-1">
          {onReload && (
            <button
              onClick={onReload}
              disabled={loading}
              className="text-xs text-text-subtle hover:text-text-primary px-1 disabled:opacity-50"
              title="Refresh usage data"
            >
              <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
            </button>
          )}
          <button
            onClick={onClose}
            className="text-xs text-text-subtle hover:text-text-primary px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {hasBuckets ? (
        <div className="space-y-2.5">
          <BucketRow label="5-Hour Session" bucket={usage.session} />
          <BucketRow label="Weekly" bucket={usage.weekly} />
          <BucketRow label="Weekly (Opus)" bucket={usage.weeklyOpus} />
          <BucketRow label="Weekly (Sonnet)" bucket={usage.weeklySonnet} />
        </div>
      ) : (
        <p className="text-xs text-text-subtle">
          No data — run <code className="bg-surface-elevated px-1 rounded">bun install</code>
        </p>
      )}

      {hasCost && (
        <div className="border-t border-border pt-2 space-y-1">
          {usage.queryCostUsd != null && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-subtle">Last query</span>
              <span className="text-text-primary font-medium tabular-nums">
                ${usage.queryCostUsd.toFixed(4)}
              </span>
            </div>
          )}
          {usage.totalCostUsd != null && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-subtle">Session total</span>
              <span className="text-text-primary font-medium tabular-nums">
                ${usage.totalCostUsd.toFixed(4)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
