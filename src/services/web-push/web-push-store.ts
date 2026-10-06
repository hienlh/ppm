/**
 * Where Web Push keeps its key pair and its subscriptions: two rows of the config
 * key/value table.
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

export interface StoredSubscription {
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
  const v = value as Partial<StoredSubscription> | null;
  return !!v && typeof v.id === "string" && typeof v.endpoint === "string"
    && typeof v.p256dh === "string" && typeof v.auth === "string";
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

export type NewSubscription = Pick<StoredSubscription, "endpoint" | "p256dh" | "auth" | "label" | "origin" | "vapidKey">;

/** Add a browser, or refresh it if the endpoint is already known. Newest first. */
export function upsertSubscription(input: NewSubscription): StoredSubscription {
  const list = listSubscriptions();
  const existing = list.find((s) => s.endpoint === input.endpoint);
  const record: StoredSubscription = existing
    ? { ...existing, ...input, lastError: null }
    : { ...input, id: randomUUID(), createdAt: Date.now(), lastSuccessAt: null, lastError: null };
  save([record, ...list.filter((s) => s.endpoint !== input.endpoint)].slice(0, MAX_PUSH_DEVICES));
  return record;
}

export function removeSubscription(match: { id?: string; endpoint?: string }): boolean {
  const list = listSubscriptions();
  const next = list.filter((s) => !(match.id && s.id === match.id) && !(match.endpoint && s.endpoint === match.endpoint));
  if (next.length === list.length) return false;
  save(next);
  return true;
}

export function updateSubscription(id: string, patch: Partial<Pick<StoredSubscription, "lastSuccessAt" | "lastError">>): void {
  const list = listSubscriptions();
  const index = list.findIndex((s) => s.id === id);
  if (index === -1) return;
  list[index] = { ...list[index]!, ...patch };
  save(list);
}
