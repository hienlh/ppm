import { useCallback, useEffect, useRef } from "react";
import { pickAccountForTab, type PickedAccount } from "@/lib/api-settings";
import { usePanelStore } from "@/stores/panel-store";
import { patchTabMetadata } from "@/lib/patch-tab-metadata";

/** One claim per tab/provider, shared by background preparation and an early send. */
export function useChatAccountClaim(tabId: string | undefined, providerId: string, enabled: boolean) {
  const claims = useRef(new Map<string, Promise<PickedAccount | null>>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const claim = useCallback((provider: string): Promise<PickedAccount | null> => {
    if (!tabId) return Promise.resolve(null);
    const metadata = usePanelStore.getState().getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId)?.metadata;
    if (metadata?.pickedAccountProvider === provider && typeof metadata.pickedAccountId === "string") {
      return Promise.resolve({ id: metadata.pickedAccountId, label: typeof metadata.pickedAccountLabel === "string" ? metadata.pickedAccountLabel : null });
    }
    const applyClaim = (picked: PickedAccount | null) => {
      const current = usePanelStore.getState().getPanelForTab(tabId)?.tabs.find((t) => t.id === tabId)?.metadata;
      if (picked && mounted.current && current && !current.sessionId && (!current.pickedAccountId || current.pickedAccountProvider !== provider)
        && (current.providerPending || current.providerId === provider)) {
        patchTabMetadata(tabId, { pickedAccountId: picked.id, pickedAccountLabel: picked.label, pickedAccountProvider: provider });
      }
      return picked;
    };
    const existing = claims.current.get(provider);
    if (existing) return existing.then(applyClaim);
    const promise = pickAccountForTab(provider, AbortSignal.timeout(30_000)).then(applyClaim).catch((error) => {
      if (claims.current.get(provider) === promise) claims.current.delete(provider);
      throw error;
    });
    claims.current.set(provider, promise);
    return promise;
  }, [tabId]);
  useEffect(() => { if (enabled) void claim(providerId).catch(() => {}); }, [enabled, providerId, claim]);
  return claim;
}
