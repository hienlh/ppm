import { useRef, useEffect, memo } from "react";

interface SparklineCanvasProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

export const SparklineCanvas = memo(function SparklineCanvas({
  data,
  width = 120,
  height = 24,
  color = "#3b82f6",
}: SparklineCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawRef = useRef(0);

  useEffect(() => {
    const now = Date.now();
    // Throttle redraws to 1fps
    if (now - lastDrawRef.current < 1000) return;
    lastDrawRef.current = now;

    const canvas = canvasRef.current;
    if (!canvas || data.length < 2) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    const max = Math.max(...data, 1);
    const stepX = width / (data.length - 1);
    const padding = 2;
    const drawH = height - padding * 2;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";

    for (let i = 0; i < data.length; i++) {
      const x = i * stepX;
      const y = padding + drawH - (data[i]! / max) * drawH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [data, width, height, color]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className="inline-block"
    />
  );
});
