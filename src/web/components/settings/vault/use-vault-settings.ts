/**
 * What Settings → Vault shows: the tiers' status, every item's name, and the public tier's
 * values (plain text by design, so the pane lists them). A locked value is never loaded here;
 * a row asks for it on Show and drops it again.
 */
import { useCallback, useEffect, useState } from "react";
import { vaultApi, vaultFailure, type VaultStatusResponse } from "@/lib/vault-client";
import type { VaultItemMeta } from "../../../../shared/vault";

export interface VaultSettingsData {
  status: VaultStatusResponse;
  items: VaultItemMeta[];
  /** Public item id → its value. */
  publicValues: Record<string, string>;
}

export function useVaultSettings() {
  const [data, setData] = useState<VaultSettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [status, items] = await Promise.all([vaultApi.status(), vaultApi.items()]);
      const publicItems = items.filter((i) => i.tier === "public");
      const values = await Promise.all(publicItems.map((i) => vaultApi.reveal(i.id).then((v) => [i.id, v.value] as const)));
      setData({ status, items, publicValues: Object.fromEntries(values) });
      setError(null);
    } catch (e) {
      setError(vaultFailure(e).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  return { data, error, refresh };
}
