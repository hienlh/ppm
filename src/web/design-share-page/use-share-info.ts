import { useCallback, useEffect, useState } from "react";
import type { DesignShareGuestInfo } from "../../shared/design-share-guest-types";
import { fetchShareInfo, ShareApiError, failureMessage } from "./share-api";

/** What `/s/<code>/info` said: still loading, the shared version, a dead link, or a failure to retry. */
export type ShareInfoState =
  | { status: "loading" }
  | { status: "ready"; info: DesignShareGuestInfo }
  | { status: "invalid" }
  | { status: "error"; message: string };

export function useShareInfo(code: string | null): { state: ShareInfoState; retry: () => void } {
  const [state, setState] = useState<ShareInfoState>(code ? { status: "loading" } : { status: "invalid" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    setState({ status: "loading" });
    fetchShareInfo(code).then(
      (info) => { if (!cancelled) setState({ status: "ready", info }); },
      (e: unknown) => {
        if (cancelled) return;
        const failure = e instanceof ShareApiError ? e.failure : null;
        if (failure?.kind === "invalid") setState({ status: "invalid" });
        else setState({ status: "error", message: failure ? failureMessage(failure) : "Could not open the design." });
      },
    );
    return () => { cancelled = true; };
  }, [code, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
