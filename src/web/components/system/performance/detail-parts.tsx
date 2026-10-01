/**
 * Shared furniture for every Performance detail page, so the six of them differ
 * only in which figures they name.
 *
 * The one rule they all obey: a figure this host cannot measure is `undefined` in
 * the contract and renders as an em dash, never as 0. A zero is a claim.
 */
import { useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MetricChartCanvas, type MetricSeries } from "../metric-chart-canvas";
import type { MetricsHistoryPoint } from "../../../../types/system-metrics";

export interface DetailHeaderProps {
  title: string;
  subtitle?: string;
  /** Headline figure, already formatted. */
  value?: string;
  valueClassName?: string;
}

export function DetailHeader({ title, subtitle, value, valueClassName }: DetailHeaderProps) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-base font-semibold truncate">{title}</h3>
        {subtitle && <p className="text-xs text-text-subtle truncate" title={subtitle}>{subtitle}</p>}
      </div>
      {value !== undefined && (
        <span className={cn("text-2xl font-semibold tabular-nums shrink-0", valueClassName)}>{value}</span>
      )}
    </div>
  );
}

/** Two columns on a phone, four on a wide window. Driven by the panel's OWN width
 *  (`@container`), because a floating window is routinely narrower than the screen. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 @2xl:grid-cols-4 gap-x-4 gap-y-3">{children}</dl>;
}

export interface StatProps {
  label: string;
  /** Undefined renders as an em dash: this host cannot measure it. */
  value?: string | number | null;
  title?: string;
}

export function Stat({ label, value, title }: StatProps) {
  const text = value === undefined || value === null || value === "" ? "—" : String(value);
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-text-subtle truncate">{label}</dt>
      <dd className="text-sm tabular-nums truncate" title={title ?? text}>{text}</dd>
    </div>
  );
}

export interface DetailChartProps {
  series: MetricSeries[];
  /** Fixed ceiling, e.g. 100 for a percentage axis. Omitted autoscales. */
  maxValue?: number;
  height?: number;
  /** One entry per series, in the same order. */
  legend?: string[];
  /** Mission Center's line above the graph — "Utilisation over 6 minutes". */
  caption?: string;
  /** What the top of the axis means, right-aligned opposite the caption. A graph
   *  with no stated ceiling is a shape, not a reading. */
  ceiling?: string;
  grid?: boolean;
  stacked?: boolean;
}

export function DetailChart({
  series, maxValue, height = 120, legend, caption, ceiling, grid, stacked,
}: DetailChartProps) {
  return (
    <div className="space-y-1">
      {(caption || ceiling) && (
        <div className="flex items-baseline justify-between gap-2 text-[11px] text-text-subtle">
          <span className="truncate">{caption}</span>
          <span className="shrink-0 tabular-nums">{ceiling}</span>
        </div>
      )}
      <MetricChartCanvas
        series={series}
        height={height}
        maxValue={maxValue}
        grid={grid}
        stacked={stacked}
      />
      {legend && legend.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {legend.map((label, i) => (
            <span key={label} className="flex items-center gap-1.5 text-[11px] text-text-subtle">
              <span className="size-2 rounded-full" style={{ background: series[i]?.color }} />
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One series out of the history window. `pick` returning undefined for a point
 * contributes 0 rather than a gap — the canvas draws a continuous line, and a
 * device that appeared midway through the window has no earlier readings to draw.
 */
export function useSeries(
  history: readonly MetricsHistoryPoint[],
  pick: (point: MetricsHistoryPoint) => number | undefined,
  points = 200,
): number[] {
  return useMemo(
    () => history.slice(-points).map((p) => pick(p) ?? 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pick` is written inline at every call site; only the data should retrigger
    [history, points],
  );
}

/** A proportional bar made of labelled segments — Mission Center's memory
 *  composition strip. Segments whose values do not add to the total are scaled to
 *  whatever they do add to, so the bar is never wider than its track. */
export function CompositionBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  if (total <= 0) return null;
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-sm bg-surface-hover" role="img"
      aria-label={segments.map((s) => s.label).join(", ")}>
      {segments.map((s) => (
        <div
          key={s.label}
          className="h-full"
          style={{ width: `${(Math.max(0, s.value) / total) * 100}%`, background: s.color }}
          title={s.label}
        />
      ))}
    </div>
  );
}

export const CHART_COLORS = {
  primary: "var(--color-primary)",
  secondary: "var(--color-warning)",
  success: "var(--color-success)",
  error: "var(--color-error)",
} as const;
