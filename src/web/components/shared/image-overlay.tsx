import { useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { useImageOverlay } from "@/stores/image-overlay-store";

/** Global image lightbox overlay — mount once in app root */
export function ImageOverlay() {
  const { src, alt, close } = useImageOverlay();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    },
    [close],
  );

  useEffect(() => {
    if (!src) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [src, handleKeyDown]);

  if (!src) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={close}
    >
      <button
        onClick={close}
        className="absolute top-4 right-4 z-10 flex items-center justify-center size-8 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
        aria-label="Close"
      >
        <X className="size-5" />
      </button>

      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
