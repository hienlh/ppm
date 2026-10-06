import { randomBytes } from "node:crypto";
import type { TabOpenRequest, TabOpenResult } from "../../shared/tab-open-protocol.ts";

/**
 * The server half of the tab tools. Only a browser can open a tab, so a call is a round trip:
 * hand `tab_open` to the session's devices (`ws/chat.ts` decides which) and wait for the
 * first `tab_open_result`.
 *
 * A pending request is bound to its session; an answer from any other session is refused, so
 * a device cannot settle a call it was never asked about. A session is known by the id it goes
 * by now: Codex renames a new chat to its thread id during the first turn, after the call's
 * token was issued under the old one, and the chat's sockets move to the new id with it. Every entry leaves the map on its
 * own timer, answered or not, and a session is held to a few calls at once and a few dozen a
 * minute — an agent talked into opening tabs in a loop stops there.
 */

/** Sends the request to the session's devices; the number of sockets it went to. */
export type TabOpenDelivery = (sessionId: string, request: TabOpenRequest) => number;

export type TabOpenOutcome =
  | { ok: true; result: TabOpenResult }
  | { ok: false; reason: "no-device" | "timeout" | "busy" | "rate-limited"; message: string };

export const MAX_PENDING_TAB_OPENS = 64;
export const MAX_TAB_OPENS_IN_FLIGHT_PER_SESSION = 4;
export const MAX_TAB_OPENS_PER_MINUTE = 20;

interface Pending {
  sessionId: string;
  settle: (outcome: TabOpenOutcome) => void;
}

export function createTabOpenBroker(opts: {
  deliver: TabOpenDelivery;
  /** The id a session goes by now, following a provider's rename; the id itself by default. */
  canonical?: (sessionId: string) => string;
  now?: () => number;
  maxPending?: number;
  maxInFlightPerSession?: number;
  perMinute?: number;
}) {
  const now = opts.now ?? Date.now;
  const canonical = opts.canonical ?? ((sessionId: string) => sessionId);
  const maxPending = opts.maxPending ?? MAX_PENDING_TAB_OPENS;
  const maxInFlight = opts.maxInFlightPerSession ?? MAX_TAB_OPENS_IN_FLIGHT_PER_SESSION;
  const perMinute = opts.perMinute ?? MAX_TAB_OPENS_PER_MINUTE;
  const pending = new Map<string, Pending>();
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

  function request(asked: string, req: Omit<TabOpenRequest, "type" | "requestId">, waitMs: number): Promise<TabOpenOutcome> {
    const sessionId = canonical(asked);
    if (pending.size >= maxPending || inFlight(sessionId) >= maxInFlight) {
      return Promise.resolve({ ok: false, reason: "busy", message: "Too many tabs are already being opened for this chat; wait for them, then call again." });
    }
    if (!admit(sessionId)) {
      return Promise.resolve({ ok: false, reason: "rate-limited", message: `Tabs were opened ${perMinute} times in the last minute; wait before opening more.` });
    }
    const requestId = randomBytes(12).toString("base64url");
    return new Promise<TabOpenOutcome>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: TabOpenOutcome): void => {
        if (!pending.delete(requestId)) return;
        if (timer) clearTimeout(timer);
        done(outcome);
      };
      pending.set(requestId, { sessionId, settle });
      let reached = 0;
      try {
        reached = opts.deliver(sessionId, { type: "tab_open", requestId, ...req });
      } catch (e) {
        console.warn(`[tab-tools] delivery failed for session=${sessionId}: ${(e as Error).message}`);
      }
      if (reached === 0) {
        settle({ ok: false, reason: "no-device", message: "No PPM window has this chat open, so nothing was shown." });
        return;
      }
      timer = setTimeout(() => settle({
        ok: false, reason: "timeout",
        message: `The user's device did not confirm within ${Math.round(waitMs / 1000)} s; the tab may or may not have opened.`,
      }), waitMs);
    });
  }

  /** Settles a pending call with a device's answer; false when none is pending for this session. */
  function settle(sessionId: string, result: TabOpenResult): boolean {
    const entry = pending.get(result.requestId);
    if (!entry || canonical(entry.sessionId) !== canonical(sessionId)) return false;
    entry.settle({ ok: true, result });
    return true;
  }

  /** Drops a session's rate window, e.g. when the session is deleted. */
  function forget(sessionId: string): void {
    recent.delete(sessionId);
    recent.delete(canonical(sessionId));
  }

  return { request, settle, forget, pendingCount: () => pending.size };
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
