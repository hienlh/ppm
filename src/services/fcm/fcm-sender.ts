/**
 * Sends one push to one Android device through FCM HTTP v1.
 *
 * The message is data-only — no `notification` block — so the PPM app draws it itself, from the
 * same `WebPushPayload` a browser's service worker gets, carried as JSON in `data.ppm`.
 *
 * Nothing secret is logged or returned: a failure is described by its HTTP status and Google's
 * error code, never by the device token, the access token or anything from the service account.
 */
import type { WebPushPayload } from "../../shared/web-push-payload.ts";
import { fcmSendUrl, fcmTokenUrl } from "./fcm-api-base.ts";
import { loadFcmConfig, type FcmServiceAccount } from "./fcm-config.ts";
import { signServiceAccountAssertion } from "./fcm-jwt.ts";

/** Under FCM's 4 KB data limit with room for the envelope. */
export const MAX_FCM_DATA_BYTES = 3500;
/** How long FCM keeps trying a phone that is offline. */
const ANDROID_TTL = "86400s";
const REQUEST_TIMEOUT_MS = 10_000;
/** A cached access token is renewed this long before Google says it expires. */
const RENEW_BEFORE_MS = 5 * 60_000;

export type FcmSendOutcome =
  | { outcome: "sent" }
  /** The token will never work again: the caller forgets the device. */
  | { outcome: "removed"; status: number }
  | { outcome: "failed"; error: string };

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** `payload` as the `data.ppm` string, its body (then its title) cut until it fits. */
export function fcmDataJson(payload: WebPushPayload): string {
  let current = payload;
  let json = JSON.stringify(current);
  for (const field of ["body", "title"] as const) {
    if (bytes(json) <= MAX_FCM_DATA_BYTES) return json;
    const chars = Array.from(current[field]);
    const fits = (n: number) => bytes(JSON.stringify({ ...current, [field]: n === 0 ? "" : `${chars.slice(0, n).join("")}…` })) <= MAX_FCM_DATA_BYTES;
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    current = { ...current, [field]: lo === 0 ? "" : `${chars.slice(0, lo).join("")}…` };
    json = JSON.stringify(current);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Access token
// ---------------------------------------------------------------------------

let cached: { key: string; token: string; renewAt: number } | null = null;
let pending: { key: string; promise: Promise<string> } | null = null;

/** A different account or key must never reuse another's token. */
const cacheKey = (sa: FcmServiceAccount) => `${sa.client_email}\n${sa.private_key_id ?? ""}\n${sa.private_key}`;

export function _resetFcmTokenCacheForTests(): void {
  cached = null;
  pending = null;
}

class FcmAuthError extends Error {}

async function fetchAccessToken(sa: FcmServiceAccount): Promise<{ token: string; expiresInMs: number }> {
  const assertion = await signServiceAccountAssertion({
    clientEmail: sa.client_email,
    privateKey: sa.private_key,
    privateKeyId: typeof sa.private_key_id === "string" ? sa.private_key_id : undefined,
  });
  const res = await fetch(fcmTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
  if (!res.ok || typeof body?.access_token !== "string") {
    // `error` is a short code such as `invalid_grant`; the description is left out.
    const code = typeof body?.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? ` ${body.error}` : "";
    throw new FcmAuthError(`Firebase sign-in failed (HTTP ${res.status}${code})`);
  }
  const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return { token: body.access_token, expiresInMs: seconds * 1000 };
}

/** Cached until five minutes before it expires; concurrent sends share one request. */
async function accessToken(sa: FcmServiceAccount): Promise<string> {
  const key = cacheKey(sa);
  if (cached && cached.key === key && Date.now() < cached.renewAt) return cached.token;
  if (pending && pending.key === key) return pending.promise;
  const promise = fetchAccessToken(sa)
    .then(({ token, expiresInMs }) => {
      cached = { key, token, renewAt: Date.now() + expiresInMs - RENEW_BEFORE_MS };
      return token;
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null;
    });
  pending = { key, promise };
  return promise;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

interface FcmErrorBody {
  error?: {
    status?: unknown;
    message?: unknown;
    details?: Array<{ errorCode?: unknown; fieldViolations?: Array<{ field?: unknown }> }>;
  };
}

function readError(body: FcmErrorBody | null): { status: string; errorCode: string; aboutToken: boolean } {
  const e = body?.error;
  const details = Array.isArray(e?.details) ? e.details : [];
  const errorCode = details.map((d) => d?.errorCode).find((c): c is string => typeof c === "string") ?? "";
  const aboutToken = details.some((d) => Array.isArray(d?.fieldViolations) && d.fieldViolations.some((v) => v?.field === "message.token"))
    || (typeof e?.message === "string" && /registration token/i.test(e.message));
  return { status: typeof e?.status === "string" ? e.status : "", errorCode, aboutToken };
}

const safeCode = (s: string) => (/^[A-Z_]{1,40}$/.test(s) ? s : "");

/** Send `payload` to the device holding `token`. Never throws. */
export async function sendFcmMessage(token: string, payload: WebPushPayload): Promise<FcmSendOutcome> {
  const config = loadFcmConfig();
  if (!config) return { outcome: "failed", error: "Firebase is not set up: add it in Settings → Notifications" };
  const sa = config.serviceAccount;
  try {
    const bearer = await accessToken(sa);
    const res = await fetch(fcmSendUrl(sa.project_id.trim()), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        message: {
          token,
          data: { ppm: fcmDataJson(payload) },
          android: { priority: "HIGH", ttl: ANDROID_TTL },
        },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { outcome: "sent" };
    }
    const { status, errorCode, aboutToken } = readError((await res.json().catch(() => null)) as FcmErrorBody | null);
    // The app was uninstalled, its data cleared or the token rotated; or the token was never one.
    // An INVALID_ARGUMENT about something else is PPM's message, not the device, so it is kept.
    if (res.status === 404 || errorCode === "UNREGISTERED" || ((errorCode === "INVALID_ARGUMENT" || status === "INVALID_ARGUMENT") && aboutToken)) {
      return { outcome: "removed", status: res.status };
    }
    // A rejected access token (revoked key, clock skew): sign in again next time.
    if (res.status === 401) cached = null;
    const code = safeCode(errorCode) || safeCode(status);
    return { outcome: "failed", error: `Firebase answered ${res.status}${code ? ` ${code}` : ""}` };
  } catch (e) {
    if (e instanceof FcmAuthError) return { outcome: "failed", error: e.message };
    const msg = (e as Error).message ?? String(e);
    return { outcome: "failed", error: `Could not reach Firebase: ${msg.split(token).join("[token]").slice(0, 160)}` };
  }
}
