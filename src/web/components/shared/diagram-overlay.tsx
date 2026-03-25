import { useEffect, useCallback, useRef, useState } from "react";
import { X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { useDiagramOverlay } from "@/stores/diagram-overlay-store";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

/** Global diagram lightbox overlay with zoom & pan — mount once in app root */
export function DiagramOverlay() {
  const { svg, close } = useDiagramOverlay();
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Reset zoom/pan when opening new diagram
  useEffect(() => {
    if (svg) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [svg]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "=" || e.key === "+") setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP));
      if (e.key === "-") setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP));
      if (e.key === "0") { setZoom(1); setPan({ x: 0, y: 0 }); }
    },
    [close],
  );

  useEffect(() => {
    if (!svg) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [svg, handleKeyDown]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)));
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const handlePointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  if (!svg) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/85 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={close}
    >
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-4 py-2 bg-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-sm text-white/70">
          {Math.round(zoom * 100)}% — Scroll to zoom, drag to pan, 0 to reset
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
            className="flex items-center justify-center size-8 rounded bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label="Zoom out"
          >
            <ZoomOut className="size-4" />
          </button>
          <button
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
            className="flex items-center justify-center size-8 rounded bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label="Zoom in"
          >
            <ZoomIn className="size-4" />
          </button>
          <button
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            className="flex items-center justify-center size-8 rounded bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label="Reset zoom"
          >
            <RotateCcw className="size-4" />
          </button>
          <button
            onClick={close}
            className="flex items-center justify-center size-8 rounded bg-white/10 hover:bg-white/20 text-white transition-colors ml-2"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>
      </div>

      {/* Diagram area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          className="w-full h-full flex items-center justify-center"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
          }}
        >
          <div
            className="mermaid-overlay-content bg-white rounded-lg p-6 shadow-2xl [&_svg]:max-w-full [&_svg]:h-auto"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );
}
