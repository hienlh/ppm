/**
 * Single-use, short-lived nonces for `/ws/android`.
 *
 * The coarse PPM token already travels as `?token=` on every WS URL and proves only "holds the
 * one reusable app token". A session that hands over touch and keyboard control of a running
 * VM needs more than that, so `POST /api/android/devices/:id/sessions` mints a nonce that must
 * be the client's *first* WS message and can be spent exactly once.
 */
const TTL_MS = 30_000;
const MAX_OUTSTANDING = 32;

interface Nonce {
  value: string;
  deviceId: string;
  expiresAt: number;
}

const outstanding = new Map<string, Nonce>();

function sweep(): void {
  const now = Date.now();
  for (const [k, n] of outstanding) if (n.expiresAt <= now) outstanding.delete(k);
  // A client that mints and never connects must not be able to grow this without bound.
  while (outstanding.size > MAX_OUTSTANDING) {
    const oldest = [...outstanding.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
    if (!oldest) break;
    outstanding.delete(oldest.value);
  }
}

export function mintAndroidNonce(deviceId: string): string {
  sweep();
  const value = crypto.randomUUID().replace(/-/g, "");
  outstanding.set(value, { value, deviceId, expiresAt: Date.now() + TTL_MS });
  return value;
}

/** Spend a nonce. Returns the device it was minted for, or null if unknown/expired/already used. */
export function consumeAndroidNonce(value: string): string | null {
  sweep();
  const n = outstanding.get(value);
  if (!n) return null;
  outstanding.delete(value);          // single use, even if the rest of the handshake fails
  return n.expiresAt > Date.now() ? n.deviceId : null;
}

/** Revoke everything — used when the PPM token changes or auth is turned off. */
export function revokeAllAndroidNonces(): void {
  outstanding.clear();
}
