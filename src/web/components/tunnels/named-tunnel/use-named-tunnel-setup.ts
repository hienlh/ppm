/**
 * State + side effects for the named-tunnel setup flow. Wraps the pure
 * `reduceStep` machine with the actual API calls and the `tunnel:*` window
 * events re-dispatched by `use-global-events.ts`. Both the first-run popup and
 * the Tunnel Manager section call this hook — each gets its own instance, but
 * both react to the same window events, so they stay in sync without a shared
 * store.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { namedTunnelApi, type LoginState, type NamedTunnelStatus } from "@/lib/api-named-tunnel";
import { reduceStep, type Step } from "./named-tunnel-step-reducer";
import { validateHostname, buildHostname } from "./hostname-validation";
import { namedTunnelCopy } from "./named-tunnel-copy";

/**
 * Last hostname confirmed live, cached in memory only (never localStorage —
 * see connection-lost-overlay.tsx for why). Read while the API is
 * unreachable, so it must survive without another fetch.
 */
let cachedNamedHostname: string | null = null;
export function getCachedNamedHostname(): string | null {
  return cachedNamedHostname;
}

const TUNNEL_EVENT_TYPES = [
  "tunnel:login_url",
  "tunnel:login_state",
  "tunnel:setup_step",
  "tunnel:setup_done",
  "tunnel:setup_pending",
  "tunnel:setup_error",
] as const;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : namedTunnelCopy.error.title;
}

export interface UseNamedTunnelSetup {
  step: Step;
  status: NamedTunnelStatus | null;
  answerYes: () => void;
  answerNo: () => void;
  cancelLogin: () => void;
  retryLogin: () => void;
  confirmZone: () => void;
  startOver: () => void;
  setHostnamePrefix: (prefix: string) => void;
  submitHostname: () => void;
  requestRelogin: () => void;
  close: () => void;
  refreshStatus: () => Promise<void>;
}

export function useNamedTunnelSetup(): UseNamedTunnelSetup {
  const [step, setStep] = useState<Step>({ k: "hidden" });
  const [status, setStatus] = useState<NamedTunnelStatus | null>(null);
  const zoneInFlight = useRef(false);
  // Mirrors `step` for reads inside callbacks that must not sit in a setState
  // updater — React (Strict Mode) can invoke an updater twice, which would
  // fire the setup/zone POST twice.
  const stepRef = useRef(step);
  stepRef.current = step;
  const dispatch = useCallback((action: Parameters<typeof reduceStep>[1]) => {
    setStep((prev) => reduceStep(prev, action));
  }, []);

  const loadZone = useCallback(() => {
    if (zoneInFlight.current) return;
    zoneInFlight.current = true;
    namedTunnelApi.zone()
      .then((info) => dispatch({ type: "zone-loaded", zone: info.zone }))
      .catch((e) => dispatch({ type: "zone-error", message: errorMessage(e) }))
      .finally(() => { zoneInFlight.current = false; });
  }, [dispatch]);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await namedTunnelApi.status();
      setStatus(s);
      if (s.mode === "named" && s.hostname) cachedNamedHostname = s.hostname;
      dispatch({ type: "status", status: s });
      if (s.login.state === "success") loadZone();
    } catch {
      // Offline at mount — popup/section just stay on their last known state.
    }
  }, [dispatch, loadZone]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  useEffect(() => {
    function handle(e: Event) {
      const detail = (e as CustomEvent).detail as Record<string, unknown> & { type: string };
      switch (detail.type) {
        case "tunnel:login_url":
          dispatch({ type: "login-url", url: detail.url as string });
          break;
        case "tunnel:login_state": {
          const state = detail.state as LoginState;
          dispatch({ type: "login-state", state, message: (detail.message as string | null) ?? null });
          // Success can mean "cert renewed" (re-login on an already-named
          // install) as much as "first-time login" — refresh so certState
          // and mode never sit stale behind the step machine.
          if (state === "success") { loadZone(); void refreshStatus(); }
          break;
        }
        case "tunnel:setup_step":
          dispatch({ type: "setup-step", message: detail.message as string });
          break;
        case "tunnel:setup_done":
          cachedNamedHostname = detail.hostname as string;
          dispatch({ type: "setup-done", hostname: detail.hostname as string });
          void refreshStatus();
          break;
        case "tunnel:setup_pending":
          dispatch({ type: "setup-pending", hostname: detail.hostname as string, message: detail.message as string });
          void refreshStatus();
          break;
        case "tunnel:setup_error":
          dispatch({ type: "setup-error", message: detail.message as string });
          break;
      }
    }
    TUNNEL_EVENT_TYPES.forEach((t) => window.addEventListener(t, handle));
    return () => TUNNEL_EVENT_TYPES.forEach((t) => window.removeEventListener(t, handle));
  }, [dispatch, loadZone, refreshStatus]);

  const startLogin = useCallback((relogin: boolean) => {
    dispatch({ type: "answer-yes" });
    namedTunnelApi.login(relogin)
      .then((snap) => {
        if (snap.url) dispatch({ type: "login-url", url: snap.url });
        dispatch({ type: "login-state", state: snap.state, message: snap.message });
        if (snap.state === "success") { loadZone(); void refreshStatus(); }
      })
      .catch((e) => dispatch({ type: "login-state", state: "error", message: errorMessage(e) }));
  }, [dispatch, loadZone, refreshStatus]);

  const answerYes = useCallback(() => startLogin(false), [startLogin]);
  const retryLogin = useCallback(() => startLogin(false), [startLogin]);
  const requestRelogin = useCallback(() => startLogin(true), [startLogin]);

  const answerNo = useCallback(() => {
    dispatch({ type: "answer-no" });
    // Best-effort: the popup already stopped nagging locally even if this fails.
    void namedTunnelApi.dismiss().catch(() => {});
  }, [dispatch]);

  const cancelLogin = useCallback(() => {
    dispatch({ type: "cancel" });
    void namedTunnelApi.cancelLogin().catch(() => {});
  }, [dispatch]);

  const confirmZone = useCallback(() => dispatch({ type: "confirm-zone" }), [dispatch]);
  const startOver = useCallback(() => dispatch({ type: "start-over" }), [dispatch]);
  const close = useCallback(() => dispatch({ type: "close" }), [dispatch]);

  const setHostnamePrefix = useCallback((prefix: string) => {
    const prev = stepRef.current;
    if (prev.k !== "choose-hostname") return;
    const check = validateHostname(buildHostname(prefix, prev.zone), prev.zone);
    dispatch({ type: "hostname-prefix", prefix, error: check.ok ? undefined : check.reason });
  }, [dispatch]);

  const submitHostname = useCallback(() => {
    const prev = stepRef.current;
    if (prev.k !== "choose-hostname") return;
    const hostname = buildHostname(prev.prefix, prev.zone);
    const check = validateHostname(hostname, prev.zone);
    if (!check.ok) {
      dispatch({ type: "hostname-prefix", prefix: prev.prefix, error: check.reason });
      return;
    }

    dispatch({ type: "submit" });
    namedTunnelApi.setup(hostname)
      .then((result) => {
        cachedNamedHostname = result.hostname;
        if (result.pending) {
          dispatch({ type: "setup-pending", hostname: result.hostname, message: result.message ?? namedTunnelCopy.pending.title });
        } else {
          dispatch({ type: "setup-done", hostname: result.hostname });
        }
        // The done/pending cards are terminal (not in STATUS_RESETTABLE), so
        // this only ever refreshes the separate `status` snapshot — never
        // clobbers the card the user is looking at.
        void refreshStatus();
      })
      .catch((e) => dispatch({ type: "setup-error", message: errorMessage(e) }));
  }, [dispatch, refreshStatus]);

  return {
    step, status, answerYes, answerNo, cancelLogin, retryLogin,
    confirmZone, startOver, setHostnamePrefix, submitHostname,
    requestRelogin, close, refreshStatus,
  };
}
