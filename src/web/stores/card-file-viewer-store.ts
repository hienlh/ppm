import { create } from "zustand";

/**
 * Which report-card file the full-screen viewer shows (`card-file-viewer.tsx`), if any. Opened
 * from a `/card-file/<id>` address (the link on a Telegram card) or a card's Open button.
 */
interface CardFileViewerState {
  id: string | null;
  open(id: string): void;
  close(): void;
}

export const useCardFileViewer = create<CardFileViewerState>((set) => ({
  id: null,
  open: (id) => set({ id }),
  close: () => set({ id: null }),
}));
