/**
 * Where Web Push keeps its key pair and its subscriptions: two rows of the config
 * key/value table. The subscription list also holds the PPM Android app's Firebase
 * registrations (`kind: "fcm"`), so every device is listed, tested and removed the same way.
 *
 * Neither is a `CONFIG_TABLE_KEYS` row, so neither is ever loaded into the config
 * object — which is what keeps the VAPID private key away from every surface that
 * dumps config (`ppm config get`, the extension RPC). A table would have needed a
 * migration for a list that holds a handful of browsers.
 */
import { randomUUID } from "node:crypto";
import { getConfigValue, setConfigValue } from "../db.service.ts";
import { generateVapidKeys, type VapidKeys } from "./web-push-crypto.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("web-push");

const VAPID_ROW = "web_push_vapid";
const SUBSCRIPTIONS_ROW = "web_push_subscriptions";

/** Oldest dropped beyond this. Each one is a browser someone turned push on in. */
export const MAX_PUSH_DEVICES = 50;

/** A browser's Web Push subscription. Rows saved before FCM have no `kind`. */
export interface StoredWebPushSubscription {
  kind?: "webpush";
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  /** The page origin push was turned on from — where a click on the notification goes back to. */
  origin: string;
  /** VAPID public key the subscription was made with. A push service refuses any other. */
  vapidKey: string;
  createdAt: number;
  lastSuccessAt: number | null;
  lastError: string | null;
}

/** The PPM Android app, reached through Firebase Cloud Messaging with its registration token. */
export interface StoredFcmSubscription {
  kind: "fcm";
  id: string;
  token: string;
  label: string;
  /** The PPM address the app subscribed through, "" when it did not say. A click opens it. */
  origin: string;
  createdAt: number;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export type StoredSubscription = StoredWebPushSubscription | StoredFcmSubscription;

export const isFcmSubscription = (s: StoredSubscription): s is StoredFcmSubscription => s.kind === "fcm";

function isVapidKeys(value: unknown): value is VapidKeys {
  const v = value as Partial<VapidKeys> | null;
  return !!v && typeof v.publicKey === "string" && !!v.privateJwk && typeof v.privateJwk === "object";
}

let generating: Promise<VapidKeys> | null = null;

/** The server's key pair, generated and stored the first time anything asks. */
export function getVapidKeys(): Promise<VapidKeys> {
  const raw = getConfigValue(VAPID_ROW);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (isVapidKeys(parsed)) return Promise.resolve(parsed);
    } catch { /* regenerate below */ }
  }
  // Two first requests at once must not mint two key pairs: the second would orphan
  // whatever subscribed against the first.
  generating ??= generateVapidKeys()
    .then((keys) => {
      setConfigValue(VAPID_ROW, JSON.stringify(keys));
      // A push service refuses a subscription made with another key, so every browser has to subscribe again.
      if (raw) log.warn(`VAPID keys unreadable — generated a new pair; ${listSubscriptions().length} push subscription(s) must subscribe again`);
      else log.info("Generated the VAPID key pair");
      return keys;
    })
    .finally(() => { generating = null; });
  return generating;
}

function isStored(value: unknown): value is StoredSubscription {
  const v = value as { id?: unknown; kind?: unknown; token?: unknown; endpoint?: unknown; p256dh?: unknown; auth?: unknown } | null;
  if (!v || typeof v.id !== "string") return false;
  if (v.kind === "fcm") return typeof v.token === "string";
  return typeof v.endpoint === "string" && typeof v.p256dh === "string" && typeof v.auth === "string";
}

export function listSubscriptions(): StoredSubscription[] {
  const raw = getConfigValue(SUBSCRIPTIONS_ROW);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStored) : [];
  } catch {
    return [];
  }
}

function save(list: StoredSubscription[]): void {
  setConfigValue(SUBSCRIPTIONS_ROW, JSON.stringify(list));
}

export type NewSubscription = Pick<StoredWebPushSubscription, "endpoint" | "p256dh" | "auth" | "label" | "origin" | "vapidKey">;

const endpointOf = (s: StoredSubscription) => (isFcmSubscription(s) ? null : s.endpoint);
const tokenOf = (s: StoredSubscription) => (isFcmSubscription(s) ? s.token : null);

/** Add a browser, or refresh it if the endpoint is already known. Newest first. */
export function upsertSubscription(input: NewSubscription): StoredWebPushSubscription {
  const list = listSubscriptions();
  const existing = list.find((s): s is StoredWebPushSubscription => endpointOf(s) === input.endpoint);
  const record: StoredWebPushSubscription = existing
    ? { ...existing, ...input, lastError: null }
    : { ...input, id: randomUUID(), createdAt: Date.now(), lastSuccessAt: null, lastError: null };
  save([record, ...list.filter((s) => endpointOf(s) !== input.endpoint)].slice(0, MAX_PUSH_DEVICES));
  return record;
}

export interface NewFcmSubscription {
  token: string;
  label: string;
  origin: string;
  /**
   * The subscription this device held before (its saved device id): a new token, or a switch from
   * UnifiedPush to Firebase, replaces that row and keeps its id instead of adding a second one.
   */
  replaceId?: string;
}

/** Add an Android device, or refresh it if the token (or the row it replaces) is already known. */
export function upsertFcmSubscription(input: NewFcmSubscription): StoredFcmSubscription {
  const list = listSubscriptions();
  const existing = list.find((s) => tokenOf(s) === input.token)
    ?? (input.replaceId ? list.find((s) => s.id === input.replaceId) : undefined);
  const record: StoredFcmSubscription = {
    kind: "fcm",
    id: existing?.id ?? randomUUID(),
    token: input.token,
    label: input.label,
    origin: input.origin,
    createdAt: existing?.createdAt ?? Date.now(),
    lastSuccessAt: existing && isFcmSubscription(existing) ? existing.lastSuccessAt : null,
    lastError: null,
  };
  const rest = list.filter((s) => tokenOf(s) !== input.token && s.id !== record.id && !(input.replaceId && s.id === input.replaceId));
  save([record, ...rest].slice(0, MAX_PUSH_DEVICES));
  return record;
}

export function removeSubscription(match: { id?: string; endpoint?: string; token?: string }): boolean {
  const list = listSubscriptions();
  const next = list.filter((s) => !(match.id && s.id === match.id)
    && !(match.endpoint && endpointOf(s) === match.endpoint)
    && !(match.token && tokenOf(s) === match.token));
  if (next.length === list.length) return false;
  save(next);
  return true;
}

export function updateSubscription(id: string, patch: Partial<Pick<StoredWebPushSubscription, "lastSuccessAt" | "lastError">>): void {
  const list = listSubscriptions();
  const index = list.findIndex((s) => s.id === id);
  if (index === -1) return;
  list[index] = { ...list[index]!, ...patch };
  save(list);
}
