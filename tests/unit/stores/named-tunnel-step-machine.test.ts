import { describe, it, expect } from "bun:test";
import {
  reduceStep,
  initialStepFromStatus,
  type Step,
} from "../../../src/web/components/tunnels/named-tunnel/named-tunnel-step-reducer.ts";
import type { NamedTunnelStatus } from "../../../src/web/lib/api-named-tunnel.ts";

function status(overrides: Partial<NamedTunnelStatus> = {}): NamedTunnelStatus {
  return {
    mode: "quick",
    hostname: null,
    tunnelName: null,
    tokenMasked: null,
    certState: "none",
    dismissed: false,
    login: { state: "idle", url: null, message: null },
    ...overrides,
  };
}

describe("initialStepFromStatus", () => {
  it("goes to needs-relogin when the cert is invalid, regardless of mode/dismissed", () => {
    const s = status({ certState: "invalid", mode: "named", dismissed: true });
    expect(initialStepFromStatus(s)).toEqual({ k: "needs-relogin", message: expect.any(String) });
  });

  it("stays hidden once mode is named (already set up)", () => {
    expect(initialStepFromStatus(status({ mode: "named" }))).toEqual({ k: "hidden" });
  });

  it("stays hidden once dismissed", () => {
    expect(initialStepFromStatus(status({ dismissed: true }))).toEqual({ k: "hidden" });
  });

  it("asks the domain question on a fresh, never-touched profile", () => {
    expect(initialStepFromStatus(status())).toEqual({ k: "ask-domain" });
  });

  it("resumes login-wait with slow=false on a waiting login", () => {
    const s = status({ login: { state: "waiting", url: "https://dash/x", message: null } });
    expect(initialStepFromStatus(s)).toEqual({ k: "login-wait", url: "https://dash/x", slow: false });
  });

  it("resumes login-wait with slow=true on a slow login — no clock restarts on remount", () => {
    const s = status({ login: { state: "slow", url: "https://dash/x", message: null } });
    expect(initialStepFromStatus(s)).toEqual({ k: "login-wait", url: "https://dash/x", slow: true });
  });

  it("maps timeout/cancelled/error login states to their own steps", () => {
    expect(initialStepFromStatus(status({ login: { state: "timeout", url: null, message: null } }))).toEqual({ k: "login-timeout" });
    expect(initialStepFromStatus(status({ login: { state: "cancelled", url: null, message: null } }))).toEqual({ k: "login-cancelled" });
    expect(initialStepFromStatus(status({ login: { state: "error", url: null, message: "boom" } }))).toEqual({ k: "error", message: "boom" });
  });

  it("shows a spinner (login-wait) on success — zone lookup is a hook-level effect", () => {
    const s = status({ login: { state: "success", url: null, message: null } });
    expect(initialStepFromStatus(s)).toEqual({ k: "login-wait", url: null, slow: false });
  });
});

describe("reduceStep — login flow", () => {
  it("ask-domain + answer-yes → login-wait", () => {
    const step: Step = { k: "ask-domain" };
    expect(reduceStep(step, { type: "answer-yes" })).toEqual({ k: "login-wait", url: null, slow: false });
  });

  it("ask-domain + answer-no → no-domain", () => {
    const step: Step = { k: "ask-domain" };
    expect(reduceStep(step, { type: "answer-no" })).toEqual({ k: "no-domain" });
  });

  it("login-url merges into an existing login-wait without resetting slow", () => {
    const step: Step = { k: "login-wait", url: null, slow: true };
    expect(reduceStep(step, { type: "login-url", url: "https://x" })).toEqual({ k: "login-wait", url: "https://x", slow: true });
  });

  it("login-state slow keeps the known url and flips the banner on", () => {
    const step: Step = { k: "login-wait", url: "https://x", slow: false };
    expect(reduceStep(step, { type: "login-state", state: "slow" })).toEqual({ k: "login-wait", url: "https://x", slow: true });
  });

  it("login-state timeout moves out of login-wait entirely", () => {
    const step: Step = { k: "login-wait", url: "https://x", slow: true };
    expect(reduceStep(step, { type: "login-state", state: "timeout" })).toEqual({ k: "login-timeout" });
  });

  it("login-state cancelled moves to login-cancelled", () => {
    const step: Step = { k: "login-wait", url: null, slow: false };
    expect(reduceStep(step, { type: "login-state", state: "cancelled" })).toEqual({ k: "login-cancelled" });
  });

  it("cancel action jumps straight to login-cancelled (optimistic, before the API call resolves)", () => {
    const step: Step = { k: "login-wait", url: "https://x", slow: true };
    expect(reduceStep(step, { type: "cancel" })).toEqual({ k: "login-cancelled" });
  });

  it("retry always spawns a fresh login-wait with no stale url", () => {
    expect(reduceStep({ k: "login-timeout" }, { type: "retry" })).toEqual({ k: "login-wait", url: null, slow: false });
    expect(reduceStep({ k: "login-cancelled" }, { type: "retry" })).toEqual({ k: "login-wait", url: null, slow: false });
  });
});

describe("reduceStep — zone + hostname flow", () => {
  it("zone-loaded moves to confirm-zone with the resolved zone", () => {
    const step: Step = { k: "login-wait", url: null, slow: false };
    expect(reduceStep(step, { type: "zone-loaded", zone: "example.com" })).toEqual({ k: "confirm-zone", zone: "example.com" });
  });

  it("zone-error surfaces as the generic error step", () => {
    const step: Step = { k: "login-wait", url: null, slow: false };
    expect(reduceStep(step, { type: "zone-error", message: "not logged in" })).toEqual({ k: "error", message: "not logged in" });
  });

  it("confirm-zone action proposes the default 'ppm' prefix", () => {
    const step: Step = { k: "confirm-zone", zone: "example.com" };
    expect(reduceStep(step, { type: "confirm-zone" })).toEqual({ k: "choose-hostname", zone: "example.com", prefix: "ppm" });
  });

  it("start-over from confirm-zone restarts the domain question", () => {
    const step: Step = { k: "confirm-zone", zone: "example.com" };
    expect(reduceStep(step, { type: "start-over" })).toEqual({ k: "ask-domain" });
  });

  it("hostname-prefix updates prefix and error in place", () => {
    const step: Step = { k: "choose-hostname", zone: "example.com", prefix: "ppm" };
    expect(reduceStep(step, { type: "hostname-prefix", prefix: "www", error: "www is reserved" }))
      .toEqual({ k: "choose-hostname", zone: "example.com", prefix: "www", error: "www is reserved" });
  });

  it("submit carries zone+prefix into applying, so a later error can return to the same field state", () => {
    const step: Step = { k: "choose-hostname", zone: "example.com", prefix: "ppm" };
    expect(reduceStep(step, { type: "submit" })).toEqual({ k: "applying", zone: "example.com", prefix: "ppm", message: expect.any(String) });
  });

  it("setup-step updates only the progress message", () => {
    const step: Step = { k: "applying", zone: "example.com", prefix: "ppm", message: "reading zone" };
    expect(reduceStep(step, { type: "setup-step", message: "routing DNS" }))
      .toEqual({ k: "applying", zone: "example.com", prefix: "ppm", message: "routing DNS" });
  });

  it("setup-done reaches the terminal done step", () => {
    const step: Step = { k: "applying", zone: "example.com", prefix: "ppm", message: "…" };
    expect(reduceStep(step, { type: "setup-done", hostname: "ppm.example.com" })).toEqual({ k: "done", hostname: "ppm.example.com" });
  });

  it("setup-pending reaches the pending step with the supervisor's message", () => {
    const step: Step = { k: "applying", zone: "example.com", prefix: "ppm", message: "…" };
    expect(reduceStep(step, { type: "setup-pending", hostname: "ppm.example.com", message: "run `ppm restart`" }))
      .toEqual({ k: "pending", hostname: "ppm.example.com", message: "run `ppm restart`" });
  });

  it("setup-error (e.g. 'already in use') returns to choose-hostname with the reason inline, prefix preserved", () => {
    const step: Step = { k: "applying", zone: "example.com", prefix: "taken", message: "…" };
    expect(reduceStep(step, { type: "setup-error", message: "already in use" }))
      .toEqual({ k: "choose-hostname", zone: "example.com", prefix: "taken", error: "already in use" });
  });

  it("setup-error outside of applying falls back to the generic error step", () => {
    const step: Step = { k: "login-wait", url: null, slow: false };
    expect(reduceStep(step, { type: "setup-error", message: "boom" })).toEqual({ k: "error", message: "boom" });
  });
});

describe("reduceStep — misc", () => {
  it("needs-relogin can be reached from any step", () => {
    expect(reduceStep({ k: "done", hostname: "x" }, { type: "needs-relogin", message: "renew" }))
      .toEqual({ k: "needs-relogin", message: "renew" });
  });

  it("close always returns to hidden", () => {
    expect(reduceStep({ k: "pending", hostname: "x", message: "…" }, { type: "close" })).toEqual({ k: "hidden" });
  });

  it("ignores actions that do not apply to the current step (no-op, not a crash)", () => {
    const step: Step = { k: "ask-domain" };
    expect(reduceStep(step, { type: "hostname-prefix", prefix: "x" })).toEqual(step);
    expect(reduceStep(step, { type: "confirm-zone" })).toEqual(step);
    expect(reduceStep(step, { type: "setup-step", message: "x" })).toEqual(step);
  });
});
