/**
 * Pure step machine for the named-tunnel first-run flow. No side effects here
 * (no fetch, no window events) — `use-named-tunnel-setup.ts` owns those and
 * dispatches actions into `reduceStep`. Kept side-effect-free so the whole
 * transition table is unit-testable without mocking the network or WS.
 */
import type { LoginState, NamedTunnelStatus } from "@/lib/api-named-tunnel";
import { namedTunnelCopy } from "./named-tunnel-copy";
import { DEFAULT_HOSTNAME_PREFIX } from "./hostname-validation";

export type Step =
  | { k: "hidden" }
  | { k: "ask-domain" }
  | { k: "no-domain" }
  | { k: "login-wait"; url: string | null; slow: boolean }
  | { k: "login-timeout" }
  | { k: "login-cancelled" }
  | { k: "confirm-zone"; zone: string }
  | { k: "needs-relogin"; message: string }
  | { k: "choose-hostname"; zone: string; prefix: string; error?: string }
  | { k: "applying"; zone: string; prefix: string; message: string }
  | { k: "done"; hostname: string }
  | { k: "pending"; hostname: string; message: string }
  | { k: "error"; message: string };

export type Action =
  | { type: "status"; status: NamedTunnelStatus }
  | { type: "answer-yes" }
  | { type: "answer-no" }
  | { type: "login-url"; url: string }
  | { type: "login-state"; state: LoginState; message?: string | null }
  | { type: "cancel" }
  | { type: "retry" }
  | { type: "zone-loaded"; zone: string }
  | { type: "zone-error"; message: string }
  | { type: "confirm-zone" }
  | { type: "start-over" }
  | { type: "hostname-prefix"; prefix: string; error?: string }
  | { type: "submit" }
  | { type: "setup-step"; message: string }
  | { type: "setup-done"; hostname: string }
  | { type: "setup-pending"; hostname: string; message: string }
  | { type: "setup-error"; message: string }
  | { type: "needs-relogin"; message: string }
  | { type: "close" };

/** First step to render once `/status` has been read on mount. */
export function initialStepFromStatus(status: NamedTunnelStatus): Step {
  if (status.certState === "invalid") {
    return { k: "needs-relogin", message: namedTunnelCopy.needsRelogin.certInvalid };
  }
  if (status.mode !== "quick" || status.dismissed) {
    return { k: "hidden" };
  }
  return stepFromLoginState(status.login.state, status.login.url, status.login.message);
}

function stepFromLoginState(state: LoginState, url: string | null, message: string | null): Step {
  switch (state) {
    case "waiting":
      return { k: "login-wait", url, slow: false };
    case "slow":
      return { k: "login-wait", url, slow: true };
    case "timeout":
      return { k: "login-timeout" };
    case "cancelled":
      return { k: "login-cancelled" };
    case "error":
      return { k: "error", message: message ?? namedTunnelCopy.error.title };
    case "success":
      // Zone lookup is a hook-level side effect triggered right after this;
      // the spinner stays on the login step until `zone-loaded` arrives.
      return { k: "login-wait", url, slow: false };
    case "idle":
    default:
      return { k: "ask-domain" };
  }
}

export function reduceStep(step: Step, action: Action): Step {
  switch (action.type) {
    case "status":
      return initialStepFromStatus(action.status);

    case "answer-yes":
      return { k: "login-wait", url: null, slow: false };

    case "answer-no":
      return { k: "no-domain" };

    case "login-url":
      return step.k === "login-wait"
        ? { ...step, url: action.url }
        : { k: "login-wait", url: action.url, slow: false };

    case "login-state":
      return stepFromLoginState(action.state, step.k === "login-wait" ? step.url : null, action.message ?? null);

    case "cancel":
      return { k: "login-cancelled" };

    case "retry":
      return { k: "login-wait", url: null, slow: false };

    case "zone-loaded":
      return { k: "confirm-zone", zone: action.zone };

    case "zone-error":
      return { k: "error", message: action.message };

    case "confirm-zone":
      return step.k === "confirm-zone"
        ? { k: "choose-hostname", zone: step.zone, prefix: DEFAULT_HOSTNAME_PREFIX }
        : step;

    case "start-over":
      return { k: "ask-domain" };

    case "hostname-prefix":
      return step.k === "choose-hostname"
        ? { ...step, prefix: action.prefix, error: action.error }
        : step;

    case "submit":
      return step.k === "choose-hostname"
        ? { k: "applying", zone: step.zone, prefix: step.prefix, message: namedTunnelCopy.applying.title }
        : step;

    case "setup-step":
      return step.k === "applying" ? { ...step, message: action.message } : step;

    case "setup-done":
      return { k: "done", hostname: action.hostname };

    case "setup-pending":
      return { k: "pending", hostname: action.hostname, message: action.message };

    case "setup-error":
      // Route back to the hostname field with the reason inline — losing the
      // typed prefix here would make the user re-type it for a typo-sized fix.
      return step.k === "applying"
        ? { k: "choose-hostname", zone: step.zone, prefix: step.prefix, error: action.message }
        : { k: "error", message: action.message };

    case "needs-relogin":
      return { k: "needs-relogin", message: action.message };

    case "close":
      return { k: "hidden" };

    default:
      return step;
  }
}
