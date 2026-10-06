/**
 * Which sub-tab Settings → Remote Access shows. A store rather than component state so a link
 * from outside Settings (the Port Forwarding panel's Set up buttons) can land on a given one.
 */
import { create } from "zustand";
import { openSettings } from "../open-settings";

export type RemoteAccessTabId = "tailscale" | "public-link";

export const REMOTE_ACCESS_TABS: { id: RemoteAccessTabId; label: string }[] = [
  { id: "tailscale", label: "Tailscale" },
  { id: "public-link", label: "Public link" },
];

export const useRemoteAccessTab = create<{ tab: RemoteAccessTabId; setTab: (tab: RemoteAccessTabId) => void }>((set) => ({
  tab: "tailscale",
  setTab: (tab) => set({ tab }),
}));

/** Open Settings → Remote Access, on `tab` when one is given. */
export function openRemoteAccess(tab?: RemoteAccessTabId): void {
  if (tab) useRemoteAccessTab.getState().setTab(tab);
  openSettings("remote-access");
}
