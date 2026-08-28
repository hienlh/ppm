import { useEffect, useRef, useState } from "react";
import {
  Check, ChevronLeft, ChevronRight, Copy, Download, FlipHorizontal, FlipVertical,
  Maximize2, Minus, Plus, RotateCcw, RotateCw, Scan, X,
} from "lucide-react";
import { useImageOverlay } from "@/stores/image-overlay-store";
import { useImageTransform } from "@/hooks/use-image-transform";
import { canCopyImage, copyImageToClipboard } from "@/lib/clipboard";
import { triggerDownload } from "@/lib/file-download";
import { cn } from "@/lib/utils";

/**
 * Global image lightbox with zoom, pan, rotate and flip — mount once in app root.
 *
 * The viewer is a separate component so its gesture bindings attach on the same commit that
 * puts the container in the DOM. Running them from here would bind against a ref that is
 * still null while the overlay is closed, and they would never attach at all.
 */
export function ImageOverlay() {
  const src = useImageOverlay((s) => s.src);
  if (!src) return null;
  return <Viewer key={src} />;
}

function Viewer() {
  const { src, alt, images, index, close, go } = useImageOverlay();
  const {
    containerRef, imageRef, zoomPercent, rotation,
    zoomBy, reset, fit, actualSize, rotate, flip,
  } = useImageTransform();

  const [copied, setCopied] = useState(false);
  const copyable = canCopyImage();

  // Give the image an explicit identity transform up front, so the first gesture animates
  // from a known state rather than from an empty style. Remounting per image (see the `key`
  // above) is what keeps a 400% zoom from carrying over to the next one.
  useEffect(() => { reset(); }, [reset]);

  const actions = useRef({ close, go, zoomBy, reset, fit, actualSize, rotate, flip });
  actions.current = { close, go, zoomBy, reset, fit, actualSize, rotate, flip };

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      const a = actions.current;
      const key = e.key;
      if (key === "Escape") return a.close();
      if (key === "ArrowLeft") return a.go(-1);
      if (key === "ArrowRight") return a.go(1);
      if (key === "+" || key === "=") return a.zoomBy(1.25);
      if (key === "-" || key === "_") return a.zoomBy(0.8);
      if (key === "0") return a.fit();
      if (key === "1") return a.actualSize();
      if (key === "r") return a.rotate(90);
      if (key === "R") return a.rotate(-90);
      if (key === "h") return a.flip("x");
      if (key === "v") return a.flip("y");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [src]);

  if (!src) return null;

  const name = alt?.trim() || "image";
  const many = images.length > 1;

  const copy = async () => {
    if (await copyImageToClipboard(src)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-black/90 backdrop-blur-sm animate-in fade-in duration-150">
      <button
        onClick={close}
        className="absolute top-3 right-3 z-20 flex size-11 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:bg-white/30"
        aria-label="Close"
      >
        <X className="size-5" />
      </button>

      {many && (
        <div className="absolute top-3 left-3 z-20 rounded-full bg-white/10 px-3 py-1.5 font-mono text-xs text-white/80">
          {index + 1} / {images.length}
        </div>
      )}

      {/*
        touch-none hands every finger to the gesture handler; without it the browser claims
        the drag for its own scroll and pinch, and neither pan nor zoom ever fires.
      */}
      <div
        ref={containerRef}
        className="relative flex flex-1 touch-none select-none items-center justify-center overflow-hidden"
        onPointerDown={(e) => { if (e.target === e.currentTarget) e.currentTarget.dataset.bg = "1"; }}
        onPointerUp={(e) => {
          // Close only on a click that started and ended on the backdrop, so releasing a
          // pan outside the image does not dismiss the viewer.
          if (e.target === e.currentTarget && e.currentTarget.dataset.bg === "1") close();
          delete e.currentTarget.dataset.bg;
        }}
      >
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          style={{ willChange: "transform" }}
          className="max-h-full max-w-full object-contain rounded-lg shadow-2xl"
        />
      </div>

      <Toolbar>
        {many && (
          <>
            <ToolButton onClick={() => go(-1)} disabled={index === 0} label="Previous image (←)">
              <ChevronLeft className="size-5" />
            </ToolButton>
            <ToolButton onClick={() => go(1)} disabled={index === images.length - 1} label="Next image (→)">
              <ChevronRight className="size-5" />
            </ToolButton>
            <Divider />
          </>
        )}

        <ToolButton onClick={() => zoomBy(0.8)} label="Zoom out (-)"><Minus className="size-5" /></ToolButton>
        <button
          onClick={reset}
          className="h-11 min-w-[4.5rem] rounded-lg px-2 font-mono text-xs text-white/80 transition-colors hover:bg-white/10 active:bg-white/20"
          title="Reset view"
        >
          {zoomPercent}%
        </button>
        <ToolButton onClick={() => zoomBy(1.25)} label="Zoom in (+)"><Plus className="size-5" /></ToolButton>
        <ToolButton onClick={fit} label="Fit to screen (0)"><Maximize2 className="size-5" /></ToolButton>
        <ToolButton onClick={actualSize} label="Actual size (1)"><Scan className="size-5" /></ToolButton>

        <Divider />

        <ToolButton onClick={() => rotate(-90)} label="Rotate left (Shift+R)" active={rotation !== 0}>
          <RotateCcw className="size-5" />
        </ToolButton>
        <ToolButton onClick={() => rotate(90)} label="Rotate right (R)" active={rotation !== 0}>
          <RotateCw className="size-5" />
        </ToolButton>
        <ToolButton onClick={() => flip("x")} label="Flip horizontally (H)"><FlipHorizontal className="size-5" /></ToolButton>
        <ToolButton onClick={() => flip("y")} label="Flip vertically (V)"><FlipVertical className="size-5" /></ToolButton>

        <Divider />

        <ToolButton onClick={() => triggerDownload(src, name)} label="Download"><Download className="size-5" /></ToolButton>
        <ToolButton
          onClick={copy}
          disabled={!copyable}
          label={copyable ? "Copy image" : "Copying images needs an HTTPS or localhost address"}
        >
          {copied ? <Check className="size-5 text-green-400" /> : <Copy className="size-5" />}
        </ToolButton>
      </Toolbar>
    </div>
  );
}

/** Bottom placement keeps the controls in thumb reach on a phone (design-guidelines §9). */
function Toolbar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 justify-center px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
      <div className="flex flex-wrap items-center justify-center gap-0.5 rounded-2xl bg-white/10 p-1 backdrop-blur">
        {children}
      </div>
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-6 w-px bg-white/20" aria-hidden />;
}

function ToolButton({
  onClick, label, children, disabled, active,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-11 items-center justify-center rounded-lg text-white transition-colors",
        "hover:bg-white/15 active:bg-white/25",
        active && "text-primary",
        disabled && "pointer-events-none opacity-30",
      )}
    >
      {children}
    </button>
  );
}
