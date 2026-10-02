/**
 * A stable id for this browser, minted once. Browser rows in the session trace are keyed by it
 * (`browser:<deviceId>`), which answers "which machine does this happen on" and gives each
 * device its own rate limit on `POST /api/trace`.
 *
 * `index.html`'s boot watchdog reads and mints the same key without the bundle, so the two
 * formats must stay identical.
 */

export const DEVICE_ID_KEY = "ppm-device-id";
const VALID = /^[A-Za-z0-9-]{8,64}$/;

let memo: string | null = null;

/**
 * A v4 UUID from `getRandomValues`. Not `crypto.randomUUID`: that exists only in a secure
 * context, and PPM is routinely reached over plain HTTP on a LAN.
 */
export function uuidV4(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function getDeviceId(): string {
  if (memo) return memo;
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY);
    if (stored && VALID.test(stored)) return (memo = stored);
  } catch {
    // Private mode can refuse storage outright; an id per page load still works.
  }
  const id = uuidV4();
  try { localStorage.setItem(DEVICE_ID_KEY, id); } catch { /* see above */ }
  return (memo = id);
}
