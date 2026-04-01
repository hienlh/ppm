import { create } from "zustand";

interface ConnectionState {
  /** Whether the server is currently unreachable */
  isDown: boolean;
  /** Timestamp when the server first went down */
  downSince: number | null;
  /** Whether the overlay should be shown (down for > threshold) */
  showOverlay: boolean;

  markDown: () => void;
  markUp: () => void;
}

/** How long the server must be unreachable before showing the overlay */
const OVERLAY_THRESHOLD_MS = 15_000;

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  isDown: false,
  downSince: null,
  showOverlay: false,

  markDown: () => {
    const { downSince } = get();
    const now = Date.now();
    const since = downSince ?? now;
    const elapsed = now - since;

    set({
      isDown: true,
      downSince: since,
      showOverlay: elapsed >= OVERLAY_THRESHOLD_MS,
    });
  },

  markUp: () => {
    set({ isDown: false, downSince: null, showOverlay: false });
  },
}));
