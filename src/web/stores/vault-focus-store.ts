import { create } from "zustand";

/**
 * The vault item an address asked Settings → Vault to show (`/?openVault=<id>`, the button on a
 * vault card's Telegram notice). Settings scrolls to it, marks it for a moment, then clears it.
 * Holds an item id only, never a value.
 */
interface VaultFocusState {
  itemId: string | null;
  focus: (itemId: string | null) => void;
  clear: () => void;
}

export const useVaultFocusStore = create<VaultFocusState>((set) => ({
  itemId: null,
  focus: (itemId) => set({ itemId }),
  clear: () => set({ itemId: null }),
}));
