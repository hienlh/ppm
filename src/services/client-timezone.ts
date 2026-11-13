/**
 * The IANA time zone of the browser that last reported one, kept for extensions
 * (`vscode.env.clientTimeZone`). The host machine's own zone says nothing about the person:
 * PPM often runs on a machine in another country from the one its user is in, so anything an
 * extension shows or schedules for them has to use the zone their device reports.
 *
 * Memory only: the first browser to connect after a restart reports it again.
 */

export interface ClientTimeZoneReport {
  timeZone: string;
  deviceId: string;
  /** When the report arrived, ms since the epoch. */
  at: number;
}

/** Same shape `src/web/lib/device-id.ts` mints. */
const DEVICE_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_ZONE_LENGTH = 64;

/** Whether `Intl` knows the zone: the probe throws a RangeError for one it does not. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ZONE_LENGTH) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

let last: ClientTimeZoneReport | null = null;

/** Keep a browser's report when both fields are valid; null (and nothing kept) otherwise. */
export function recordClientTimeZone(timeZone: unknown, deviceId: unknown, now = Date.now()): ClientTimeZoneReport | null {
  if (!isValidTimeZone(timeZone) || typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) return null;
  last = { timeZone, deviceId, at: now };
  return last;
}

export function lastClientTimeZone(): ClientTimeZoneReport | null {
  return last;
}

/** Forget the report; for tests. */
export function resetClientTimeZone(): void {
  last = null;
}
