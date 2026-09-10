/**
 * Global open/close state for the single mobile remote-desktop sheet. There is exactly one
 * host to control (same as the desktop floating window, which also dedupes to one instance),
 * so — unlike the mobile explorer's per-path slices — this is just an open flag.
 */
import { create } from "zustand";

interface RemoteDesktopMobileOpenState {
  isOpen: boolean;
  open(): void;
  close(): void;
}

export const useRemoteDesktopMobileOpenState = create<RemoteDesktopMobileOpenState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
