import { useCallback, useEffect, useState } from "react";
import { getDesignShareAddress } from "@/lib/design/api-design-shares";
import { publicTunnelApi } from "@/lib/api-tunnels";
import {
  SHARE_START_POLL_MS, shareAddressView, type ShareAddressView, type ShareStartAttempt, type TunnelReload,
} from "@/lib/design/design-share-address-state";
import type { DesignShareAddress } from "../../../../shared/design-share-types";

/**
 * The public address share links open at, read while the Share dialog is open.
 *
 * Starting a temporary address is the same master switch Remote Access → Public link uses:
 * it only writes config and asks the supervisor to act, so the address arrives seconds
 * later. Until it does (or a minute passes) the address is polled every two seconds.
 */

export interface ShareAddressFeature {
  address: DesignShareAddress | null;
  view: ShareAddressView;
  refresh: () => Promise<void>;
  /** Turn the public tunnel switch on and wait for its address. */
  startTemporary: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useShareAddress(open: boolean): ShareAddressFeature {
  const [address, setAddress] = useState<DesignShareAddress | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [start, setStart] = useState<ShareStartAttempt | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getDesignShareAddress();
      setAddress(next);
      setLoadError(null);
      if (next.url && next.kind !== "none") setStart(null);
    } catch (e) {
      // Keep the last known address: a failed poll is not a state change.
      setLoadError(message(e) || "Could not read the public address");
    }
  }, []);

  const view = shareAddressView({ address, loadError, start, now: Date.now() });
  const starting = view.kind === "starting";

  useEffect(() => {
    if (!open) { setStart(null); return; }
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !starting) return;
    const timer = setInterval(() => { void refresh(); }, SHARE_START_POLL_MS);
    return () => clearInterval(timer);
  }, [open, starting, refresh]);

  const startTemporary = useCallback(async () => {
    const at = Date.now();
    setStart({ at, reload: null, error: null });
    try {
      const { reload } = await publicTunnelApi.setEnabled(true);
      setStart({ at, reload: reload as TunnelReload, error: null });
      await refresh();
    } catch (e) {
      setStart({ at, reload: null, error: `Could not turn the public address on: ${message(e)}` });
    }
  }, [refresh]);

  return { address, view, refresh, startTemporary };
}
