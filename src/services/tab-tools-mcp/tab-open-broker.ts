import { randomBytes } from "node:crypto";
import type { TabOpenRequest, TabOpenResult } from "../../shared/tab-open-protocol.ts";

/**
 * A round trip to the user's device for an AI tool: only a browser can open a tab or say what
 * it is showing, so a call hands a request to the session's devices (`ws/chat.ts` decides
 * which) and waits for the first answer.
 *
 * A pending request is bound to its session; an answer from any other session is refused, so
 * a device cannot settle a call it was never asked about. A session is known by the id it goes
 * by now: Codex renames a new chat to its thread id during the first turn, after the call's
 * token was issued under the old one, and the chat's sockets move to the new id with it. Every entry leaves the map on its
 * own timer, answered or not, and a session is held to a few calls at once and a few dozen a
 * minute — an agent talked into calling in a loop stops there.
 *
 * {@link createDeviceBroker} is the mechanism; the tab tools' {@link tabOpenBroker} and the
 * Assistant's UI broker are instances of it with their own wire messages and wording.
 */

export type DeviceBrokerFailure = "no-device" | "timeout" | "busy" | "rate-limited" | "withdrawn";

export type DeviceBrokerOutcome<Res> =
  | { ok: true; result: Res }
  | { ok: false; reason: DeviceBrokerFailure; message: string };

/** What a failed call tells the agent, worded for what the broker carries. */
export interface DeviceBrokerMessages {
  noDevice: string;
  busy: string;
  rateLimited: (perMinute: number) => string;
  timeout: (seconds: number) => string;
  /** When the caller stops waiting before an answer. */
  withdrawn?: string;
}

interface Pending<Res> {
  sessionId: string;
  settle: (outcome: DeviceBrokerOutcome<Res>) => void;
}

export function createDeviceBroker<Req, Res extends { requestId: string }, Body>(opts: {
  /** Sends the request to the session's devices; the number of sockets it went to. */
  deliver: (sessionId: string, request: Req) => number;
  /** The wire request for one call. */
  build: (requestId: string, body: Body) => Req;
  messages: DeviceBrokerMessages;
  /** Prefix of the warning logged when a delivery throws. */
  logTag: string;
  /** Told once whenever a delivered call ends, however it ended: answered, timed out or cancelled. */
  onEnd?: (sessionId: string, requestId: string, outcome: DeviceBrokerOutcome<Res>) => void;
  /** The id a session goes by now, following a provider's rename; the id itself by default. */
  canonical?: (sessionId: string) => string;
  now?: () => number;
  maxPending: number;
  maxInFlightPerSession: number;
  perMinute: number;
}) {
  const now = opts.now ?? Date.now;
  const canonical = opts.canonical ?? ((sessionId: string) => sessionId);
  const { maxPending, maxInFlightPerSession: maxInFlight, perMinute, messages } = opts;
  const pending = new Map<string, Pending<Res>>();
  const recent = new Map<string, number[]>();

  function inFlight(sessionId: string): number {
    let n = 0;
    for (const p of pending.values()) if (p.sessionId === sessionId) n++;
    return n;
  }

  /** Records a call in the session's last-minute window; false when the window is full. */
  function admit(sessionId: string): boolean {
    const cutoff = now() - 60_000;
    const times = (recent.get(sessionId) ?? []).filter((t) => t > cutoff);
    if (times.length >= perMinute) {
      recent.set(sessionId, times);
      return false;
    }
    times.push(now());
    recent.set(sessionId, times);
    return true;
  }

  /**
   * Hands `body` to the session's devices and waits up to `waitMs` for the first answer. An
   * aborted `signal` (the caller stopped waiting) withdraws the call.
   */
  function request(asked: string, body: Body, waitMs: number, signal?: AbortSignal): Promise<DeviceBrokerOutcome<Res>> {
    const sessionId = canonical(asked);
    if (signal?.aborted) return Promise.resolve({ ok: false, reason: "withdrawn", message: messages.withdrawn ?? "The call was withdrawn." });
    if (pending.size >= maxPending || inFlight(sessionId) >= maxInFlight) {
      return Promise.resolve({ ok: false, reason: "busy", message: messages.busy });
    }
    if (!admit(sessionId)) {
      return Promise.resolve({ ok: false, reason: "rate-limited", message: messages.rateLimited(perMinute) });
    }
    const requestId = randomBytes(12).toString("base64url");
    return new Promise<DeviceBrokerOutcome<Res>>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let delivered = false;
      const onAbort = (): void => settle({ ok: false, reason: "withdrawn", message: messages.withdrawn ?? "The call was withdrawn." });
      const settle = (outcome: DeviceBrokerOutcome<Res>): void => {
        if (!pending.delete(requestId)) return;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        done(outcome);
        if (!delivered || !opts.onEnd) return;
        try {
          opts.onEnd(sessionId, requestId, outcome);
        } catch (e) {
          console.warn(`[${opts.logTag}] onEnd failed for session=${sessionId}: ${(e as Error).message}`);
        }
      };
      pending.set(requestId, { sessionId, settle });
      let reached = 0;
      try {
        reached = opts.deliver(sessionId, opts.build(requestId, body));
      } catch (e) {
        console.warn(`[${opts.logTag}] delivery failed for session=${sessionId}: ${(e as Error).message}`);
      }
      if (reached === 0) {
        settle({ ok: false, reason: "no-device", message: messages.noDevice });
        return;
      }
      delivered = true;
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => settle({
        ok: false, reason: "timeout", message: messages.timeout(Math.round(waitMs / 1000)),
      }), waitMs);
    });
  }

  /** Settles a pending call with a device's answer; false when none is pending for this session. */
  function settle(sessionId: string, result: Res): boolean {
    const entry = pending.get(result.requestId);
    if (!entry || canonical(entry.sessionId) !== canonical(sessionId)) return false;
    entry.settle({ ok: true, result });
    return true;
  }

  /** Whether a call with this id is still waiting. */
  function owns(requestId: string): boolean {
    return pending.has(requestId);
  }

  /** Ends a waiting call without an answer, whichever session it is for; false when none is waiting. */
  function cancel(requestId: string, outcome: { reason: DeviceBrokerFailure; message: string }): boolean {
    const entry = pending.get(requestId);
    if (!entry) return false;
    entry.settle({ ok: false, ...outcome });
    return true;
  }

  /** The ids of the calls waiting on a session. */
  function pendingFor(sessionId: string): string[] {
    const id = canonical(sessionId);
    return [...pending].filter(([, p]) => canonical(p.sessionId) === id).map(([requestId]) => requestId);
  }

  /** Drops a session's rate window, e.g. when the session is deleted. */
  function forget(sessionId: string): void {
    recent.delete(sessionId);
    recent.delete(canonical(sessionId));
  }

  return { request, settle, owns, cancel, pendingFor, forget, pendingCount: () => pending.size };
}

/** Sends the request to the session's devices; the number of sockets it went to. */
export type TabOpenDelivery = (sessionId: string, request: TabOpenRequest) => number;

export type TabOpenOutcome = DeviceBrokerOutcome<TabOpenResult>;

export const MAX_PENDING_TAB_OPENS = 64;
export const MAX_TAB_OPENS_IN_FLIGHT_PER_SESSION = 4;
export const MAX_TAB_OPENS_PER_MINUTE = 20;

const TAB_OPEN_MESSAGES: DeviceBrokerMessages = {
  noDevice: "No PPM window has this chat open, so nothing was shown.",
  busy: "Too many tabs are already being opened for this chat; wait for them, then call again.",
  rateLimited: (perMinute) => `Tabs were opened ${perMinute} times in the last minute; wait before opening more.`,
  timeout: (seconds) => `The user's device did not confirm within ${seconds} s; the tab may or may not have opened.`,
};

export function createTabOpenBroker(opts: {
  deliver: TabOpenDelivery;
  /** The id a session goes by now, following a provider's rename; the id itself by default. */
  canonical?: (sessionId: string) => string;
  now?: () => number;
  maxPending?: number;
  maxInFlightPerSession?: number;
  perMinute?: number;
}) {
  return createDeviceBroker<TabOpenRequest, TabOpenResult, Omit<TabOpenRequest, "type" | "requestId">>({
    deliver: opts.deliver,
    build: (requestId, req) => ({ type: "tab_open", requestId, ...req }),
    messages: TAB_OPEN_MESSAGES,
    logTag: "tab-tools",
    canonical: opts.canonical,
    now: opts.now,
    maxPending: opts.maxPending ?? MAX_PENDING_TAB_OPENS,
    maxInFlightPerSession: opts.maxInFlightPerSession ?? MAX_TAB_OPENS_IN_FLIGHT_PER_SESSION,
    perMinute: opts.perMinute ?? MAX_TAB_OPENS_PER_MINUTE,
  });
}

let delivery: TabOpenDelivery | null = null;
let resolveSession: (sessionId: string) => string = (sessionId) => sessionId;

/**
 * `ws/chat.ts` owns the sockets; it registers how to reach a session's devices and how to
 * follow a session its provider renamed.
 */
export function setTabOpenDelivery(fn: TabOpenDelivery | null, canonical?: (sessionId: string) => string): void {
  delivery = fn;
  resolveSession = canonical ?? ((sessionId) => sessionId);
}

export const tabOpenBroker = createTabOpenBroker({
  deliver: (sessionId, req) => delivery?.(sessionId, req) ?? 0,
  canonical: (sessionId) => resolveSession(sessionId),
});
