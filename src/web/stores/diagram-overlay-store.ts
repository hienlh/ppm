import { create } from "zustand";

interface DiagramOverlayState {
  /** SVG markup string to display */
  svg: string | null;
  /** Open the overlay with rendered SVG */
  open: (svg: string) => void;
  /** Close the overlay */
  close: () => void;
}

export const useDiagramOverlay = create<DiagramOverlayState>((set) => ({
  svg: null,
  open: (svg) => set({ svg }),
  close: () => set({ svg: null }),
}));
