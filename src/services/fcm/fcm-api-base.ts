/**
 * Where PPM reaches Google for Android push: the OAuth token endpoint and the FCM HTTP v1 API.
 *
 * Both can be pointed at a fake for tests, and only at a loopback address — the token endpoint
 * receives an assertion signed with the service account's key and FCM receives the bearer token,
 * so an override that could name another machine would hand it both. Same rule as Telegram's.
 */
import { parseLoopbackApiBase } from "../telegram/telegram-api-base.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("fcm");

export const FCM_OAUTH_BASE_ENV = "PPM_FCM_OAUTH_BASE";
export const FCM_API_BASE_ENV = "PPM_FCM_API_BASE";
const DEFAULT_OAUTH_BASE = "https://oauth2.googleapis.com";
const DEFAULT_FCM_BASE = "https://fcm.googleapis.com";

const warned = new Set<string>();

/** Read on every call, so a test can set and clear the variable around itself. */
function base(env: string, fallback: string): string {
  const raw = process.env[env];
  if (!raw) return fallback;
  const parsed = parseLoopbackApiBase(raw);
  if (parsed) return parsed;
  if (!warned.has(env)) {
    warned.add(env);
    log.warn(`${env} ignored: only http(s)://127.0.0.1, localhost or [::1] with a port is accepted`);
  }
  return fallback;
}

export function fcmTokenUrl(): string {
  return `${base(FCM_OAUTH_BASE_ENV, DEFAULT_OAUTH_BASE)}/token`;
}

export function fcmSendUrl(projectId: string): string {
  return `${base(FCM_API_BASE_ENV, DEFAULT_FCM_BASE)}/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
}
