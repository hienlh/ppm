import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A picture shown whole, that a tap or click enlarges to its own pixels (scroll or drag to look
 * around) and a second tap fits again. Shared by the File Explorer's preview tab and a report
 * card's file viewer. Pinch zoom stays the browser's own on a phone (`touch-action` lets it
 * through), so nothing here fights the gesture.
 */
export function ZoomableImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [actual, setActual] = useState(false);
  return (
    <div
      className={cn("flex h-full w-full overflow-auto [touch-action:pan-x_pan-y_pinch-zoom]", actual ? "items-start justify-start" : "items-center justify-center", className)}
      data-testid="zoomable-image"
      data-zoom={actual ? "actual" : "fit"}
    >
      <img
        src={src}
        alt={alt}
        onClick={() => setActual((a) => !a)}
        title={actual ? "Tap to fit" : "Tap to see actual size"}
        className={cn("select-none", actual ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain")}
        draggable={false}
      />
    </div>
  );
}
