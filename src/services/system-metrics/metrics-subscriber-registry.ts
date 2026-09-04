/**
 * SSE subscriber leases. A proxy in front of PPM (Cloudflare Tunnel) may keep
 * the origin request alive after the browser left, so `cancel()` cannot be
 * trusted: each subscriber holds a lease the client renews by pinging, and the
 * server reaps silent ones. Without this, a phone that closed its tab would keep
 * the PowerShell child running forever and burn one of the five stream slots.
 */
import type { MetricsSnapshot, MetricsTier } from "../../types/system-metrics.ts";

export interface MetricsSubscriber {
  sid: string;
  tier: MetricsTier;
  lastPingAt: number;
  deliver: (snapshot: MetricsSnapshot) => void;
  /** Called once when the server drops the subscriber (reap or explicit stop). */
  close: () => void;
}

export const SID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Accept only a short opaque id so a hostile query cannot bloat the map. */
export function isValidSid(raw: string | undefined): raw is string {
  return typeof raw === "string" && SID_PATTERN.test(raw);
}

export class SubscriberRegistry {
  private readonly subs = new Map<string, MetricsSubscriber>();

  add(sub: MetricsSubscriber): void {
    this.subs.set(sub.sid, sub);
  }

  has(sid: string): boolean {
    return this.subs.has(sid);
  }

  /** Remove and end the stream, so an explicit DELETE also closes the HTTP
   *  response a proxy might otherwise hold open. `close` must be idempotent. */
  remove(sid: string): boolean {
    const s = this.subs.get(sid);
    if (!s) return false;
    this.subs.delete(sid);
    try { s.close(); } catch { /* stream already gone */ }
    return true;
  }

  ping(sid: string, now: number): boolean {
    const s = this.subs.get(sid);
    if (!s) return false;
    s.lastPingAt = now;
    return true;
  }

  /** Drop and close every lease silent for longer than `timeoutMs`. */
  reap(now: number, timeoutMs: number): MetricsSubscriber[] {
    const expired: MetricsSubscriber[] = [];
    for (const s of this.subs.values()) {
      if (now - s.lastPingAt > timeoutMs) expired.push(s);
    }
    for (const s of expired) {
      this.subs.delete(s.sid);
      try { s.close(); } catch { /* stream already gone */ }
    }
    return expired;
  }

  count(tier?: MetricsTier): number {
    if (!tier) return this.subs.size;
    let n = 0;
    for (const s of this.subs.values()) if (s.tier === tier) n++;
    return n;
  }

  list(tier: MetricsTier): MetricsSubscriber[] {
    return [...this.subs.values()].filter((s) => s.tier === tier);
  }

  /** Close everything — server shutdown. */
  clear(): void {
    for (const s of this.subs.values()) {
      try { s.close(); } catch { /* stream already gone */ }
    }
    this.subs.clear();
  }
}
