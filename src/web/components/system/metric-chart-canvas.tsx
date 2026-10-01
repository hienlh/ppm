import { useRef, useEffect, memo } from "react";
import { useElementWidth } from "@/hooks/use-element-width";
import { resolveScaleMax, resolveCssColor } from "./chart-scale";

export interface MetricSeries {
  data: number[];
  color: string;
}

interface MetricChartCanvasProps {
  /** Series drawn on the same axis. Overlaid by default; see `stacked`. */
  series: MetricSeries[];
  height: number;
  /** Fixed scale ceiling (e.g. 100 for a percentage axis). Omitted = autoscale to
   *  the max across all series in the visible window. */
  maxValue?: number;
  /** Mission Center's faint ruled background. Off by default — the Overview cards
   *  are 56px tall and a grid in there is noise rather than a reading aid. */
  grid?: boolean;
  /** Stack the series instead of overlaying them: each is drawn on top of the sum
   *  of the ones before it, so the top edge is the total. The caller supplies
   *  values that already sum to the scale (24 threads each divided by 24), because
   *  only the caller knows what the total is supposed to mean. */
  stacked?: boolean;
}

/** Mission Center's ruling: ten columns and five rows, fixed rather than derived
 *  from the point count, so the background does not crawl as the window fills. */
const GRID_COLS = 10;
const GRID_ROWS = 5;

/** The per-column sums a stack reaches, which is what its axis has to fit. */
function stackedTotals(series: MetricSeries[]): number[] {
  const len = Math.max(0, ...series.map((s) => s.data.length));
  const totals = new Array(len).fill(0);
  for (const s of series) for (let i = 0; i < s.data.length; i++) totals[i] += s.data[i] ?? 0;
  return totals;
}

/** Generalised, filled, multi-series canvas chart for the Overview cards. Fills the
 *  width of its parent — the cards live in a resizable floating window, so a fixed
 *  pixel width overflows the card as soon as the window is narrower than designed.
 *  No redraw throttle — one draw per prop change, which at a 2s tick cadence is
 *  nowhere near a frame budget. */
export const MetricChartCanvas = memo(function MetricChartCanvas({
  series,
  height,
  maxValue,
  grid = false,
  stacked = false,
}: MetricChartCanvasProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const width = useElementWidth(wrapperRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Resolved once per draw, not per point — `var(...)` is not a canvas-resolvable
    // color, so every strokeStyle/fillStyle assignment below must go through this.
    const style = getComputedStyle(canvas);
    const colorOf = (c: string) => resolveCssColor(c, style);

    const padding = 2;
    const drawH = height - padding * 2;
    const longest = Math.max(1, ...series.map((s) => s.data.length));

    // Behind everything, so a curve is never cut by a rule.
    if (grid) {
      ctx.strokeStyle = colorOf("var(--color-border)");
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = 1; c < GRID_COLS; c++) {
        const x = Math.round((width / GRID_COLS) * c) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let r = 1; r < GRID_ROWS; r++) {
        const y = Math.round((height / GRID_ROWS) * r) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // A flat baseline when there isn't enough data yet to draw a meaningful line —
    // a freshly-opened window otherwise shows nothing at all for the first tick.
    if (longest < 2) {
      ctx.beginPath();
      ctx.strokeStyle = colorOf("var(--color-border)");
      ctx.lineWidth = 1;
      ctx.moveTo(0, height - padding);
      ctx.lineTo(width, height - padding);
      ctx.stroke();
      return;
    }

    const scaleMax = resolveScaleMax(
      stacked ? stackedTotals(series) : series.flatMap((s) => s.data),
      maxValue,
    );

    if (stacked) {
      // Each band is the area between the running sum before it and after it, so
      // the visible height of a band IS that series' contribution. Drawn bottom-up
      // with a closed polygon per band rather than one fill per series over a
      // shared baseline, which would hide every series behind the first.
      const below: number[] = new Array(Math.max(0, ...series.map((x) => x.data.length))).fill(0);
      for (const s of series) {
        if (s.data.length < 2) continue;
        const stepX = width / (s.data.length - 1);
        const yOf = (v: number) => padding + drawH - (v / scaleMax) * drawH;
        ctx.beginPath();
        for (let i = 0; i < s.data.length; i++) {
          const top = (below[i] ?? 0) + (s.data[i] ?? 0);
          const p = [i * stepX, yOf(top)] as const;
          if (i === 0) ctx.moveTo(p[0], p[1]);
          else ctx.lineTo(p[0], p[1]);
        }
        for (let i = s.data.length - 1; i >= 0; i--) {
          ctx.lineTo(i * stepX, yOf(below[i] ?? 0));
        }
        ctx.closePath();
        ctx.fillStyle = colorOf(s.color);
        ctx.globalAlpha = 0.75;
        ctx.fill();
        ctx.globalAlpha = 1;
        for (let i = 0; i < s.data.length; i++) below[i] = (below[i] ?? 0) + (s.data[i] ?? 0);
      }
      return;
    }

    for (const s of series) {
      if (s.data.length < 2) continue;
      const localStepX = width / (s.data.length - 1);

      // Filled area under the line.
      ctx.beginPath();
      ctx.moveTo(0, height - padding);
      for (let i = 0; i < s.data.length; i++) {
        const x = i * localStepX;
        const y = padding + drawH - (s.data[i]! / scaleMax) * drawH;
        ctx.lineTo(x, y);
      }
      ctx.lineTo((s.data.length - 1) * localStepX, height - padding);
      ctx.closePath();
      ctx.fillStyle = colorOf(s.color);
      ctx.globalAlpha = 0.12;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Line on top.
      ctx.beginPath();
      ctx.strokeStyle = colorOf(s.color);
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      for (let i = 0; i < s.data.length; i++) {
        const x = i * localStepX;
        const y = padding + drawH - (s.data[i]! / scaleMax) * drawH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }, [series, width, height, maxValue, grid, stacked]);

  return (
    <div ref={wrapperRef} className="w-full min-w-0 overflow-hidden" style={{ height }}>
      <canvas ref={canvasRef} style={{ width: width || "100%", height }} className="block" />
    </div>
  );
});
