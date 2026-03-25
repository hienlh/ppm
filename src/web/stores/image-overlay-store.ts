import { create } from "zustand";

interface ImageOverlayState {
  /** Blob URL or data URL of the image to display */
  src: string | null;
  alt: string;
  /** Open the overlay with a given image source */
  open: (src: string, alt?: string) => void;
  /** Close the overlay */
  close: () => void;
}

export const useImageOverlay = create<ImageOverlayState>((set) => ({
  src: null,
  alt: "",
  open: (src, alt = "") => set({ src, alt }),
  close: () => set({ src: null, alt: "" }),
}));
