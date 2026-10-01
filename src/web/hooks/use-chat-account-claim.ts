import { useCallback, useEffect, useRef } from "react";
import { pickAccountForTab, type PickedAccount } from "@/lib/api-settings";
import { getPrepare, prepareFoundNoAccount } from "@/lib/new-chat-prepare-client";
import { currentTabMetadata, patchTabMetadata } from "@/lib/patch-tab-metadata";

/**
 * Writes a claimed account into a tab's metadata, unless something else already claims
 * it for this provider, the tab already has a session, or the tab's provider moved on.
 * Pure and side-effect-scoped to the store (not a hook), so `/chat/prepare`'s own fan-out
 * can apply the pick it made server-side the same way a client-driven claim would.
 */
export function applyAccountClaim(tabId: string, provider: string, picked: PickedAccount | null): PickedAccount | null {
  const current = currentTabMetadata(tabId);
  if (picked && current && !current.sessionId && (!current.pickedAccountId || current.pickedAccountProvider !== provider)
    && (current.providerPending || current.providerId === provider)) {
    patchTabMetadata(tabId, { pickedAccountId: picked.id, pickedAccountLabel: picked.label, pickedAccountProvider: provider });
  }
  return picked;
}

/** One claim per tab/provider, shared by background preparation and an early send. */
export function useChatAccountClaim(tabId: string | undefined, providerId: string, enabled: boolean) {
  const claims = useRef(new Map<string, Promise<PickedAccount | null>>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const claim = useCallback((provider: string): Promise<PickedAccount | null> => {
    if (!tabId) return Promise.resolve(null);
    const metadata = currentTabMetadata(tabId);
    if (metadata?.pickedAccountProvider === provider && typeof metadata.pickedAccountId === "string") {
      return Promise.resolve({ id: metadata.pickedAccountId, label: typeof metadata.pickedAccountLabel === "string" ? metadata.pickedAccountLabel : null });
    }
    // Prepare already asked the server for this provider and heard "nothing usable". That
    // answer stands for the tab; only a pick that timed out is worth asking for again.
    if (prepareFoundNoAccount(tabId, provider)) return Promise.resolve(null);
    const applyClaim = (picked: PickedAccount | null) => (mounted.current ? applyAccountClaim(tabId, provider, picked) : picked);
    const existing = claims.current.get(provider);
    if (existing) return existing.then(applyClaim);
    // A prepare already in flight for this tab may pick this very account server-side —
    // join it first, so a fast send does not double-pick against the same round-robin.
    const prepare = getPrepare(tabId);
    const promise = (prepare ? prepare.catch(() => null) : Promise.resolve(null))
      .then((): Promise<PickedAccount | null> | PickedAccount | null => {
        const now = currentTabMetadata(tabId);
        if (now?.pickedAccountProvider === provider && typeof now.pickedAccountId === "string") {
          return { id: now.pickedAccountId, label: typeof now.pickedAccountLabel === "string" ? now.pickedAccountLabel : null };
        }
        if (prepareFoundNoAccount(tabId, provider)) return null;
        return pickAccountForTab(provider, AbortSignal.timeout(30_000));
      })
      .then(applyClaim)
      .catch((error) => {
        if (claims.current.get(provider) === promise) claims.current.delete(provider);
        throw error;
      });
    claims.current.set(provider, promise);
    return promise;
  }, [tabId]);
  useEffect(() => { if (enabled) void claim(providerId).catch(() => {}); }, [enabled, providerId, claim]);
  return claim;
}
