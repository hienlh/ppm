import { useRef, useEffect, memo } from "react";
import { resolveScaleMax, resolveCssColor } from "./chart-scale";

interface SparklineCanvasProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Fixed scale ceiling (e.g. 100 for a percentage axis). Omitted = autoscale to
   *  the max of the visible window, same as before. */
  maxValue?: number;
}

export const SparklineCanvas = memo(function SparklineCanvas({
  data,
  width = 120,
  height = 24,
  color = "var(--color-primary)",
  maxValue,
}: SparklineCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length < 2) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const max = resolveScaleMax(data, maxValue);
    const stepX = width / (data.length - 1);
    const padding = 2;
    const drawH = height - padding * 2;

    ctx.beginPath();
    ctx.strokeStyle = resolveCssColor(color, getComputedStyle(canvas));
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";

    for (let i = 0; i < data.length; i++) {
      const x = i * stepX;
      const y = padding + drawH - (data[i]! / max) * drawH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [data, width, height, color, maxValue]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className="inline-block"
    />
  );
});
