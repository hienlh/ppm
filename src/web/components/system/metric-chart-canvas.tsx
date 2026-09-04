import { useRef, useEffect, memo } from "react";
import { useElementWidth } from "@/hooks/use-element-width";
import { resolveScaleMax, resolveCssColor } from "./chart-scale";

export interface MetricSeries {
  data: number[];
  color: string;
}

interface MetricChartCanvasProps {
  /** 1-2 series drawn on the same axis. */
  series: MetricSeries[];
  height: number;
  /** Fixed scale ceiling (e.g. 100 for a percentage axis). Omitted = autoscale to
   *  the max across all series in the visible window. */
  maxValue?: number;
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

    const scaleMax = resolveScaleMax(series.flatMap((s) => s.data), maxValue);

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
  }, [series, width, height, maxValue]);

  return (
    <div ref={wrapperRef} className="w-full min-w-0 overflow-hidden" style={{ height }}>
      <canvas ref={canvasRef} style={{ width: width || "100%", height }} className="block" />
    </div>
  );
});
