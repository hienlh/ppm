/**
 * The Firebase project PPM sends Android push through: one config row, `fcm`, holding the
 * `google-services.json` the Firebase console gives for the Android app and a service-account key.
 *
 * Like the VAPID key, the row sits outside `CONFIG_TABLE_KEYS`, so it is never loaded into the
 * config object every dump surface reads; `fcm` is in `SECRET_CONFIG_KEYS` as well. Only
 * `fcmStatus()` leaves this module towards a client, and it carries nothing from the service account.
 */
import { deleteConfigValue, getConfigValue, setConfigValue } from "../db.service.ts";
import { FCM_ANDROID_PACKAGE, type FcmAndroidConfig, type FcmStatus } from "../../shared/fcm-status.ts";
import { importServiceAccountKey } from "./fcm-jwt.ts";

export const FCM_ROW = "fcm";

/** A pasted file bigger than this is not one of the two files asked for. */
const MAX_FILE_CHARS = 256 * 1024;

export interface FcmServiceAccount {
  type: "service_account";
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  [key: string]: unknown;
}

export interface FcmConfig {
  googleServices: Record<string, unknown>;
  serviceAccount: FcmServiceAccount;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A file given either as its JSON object or as the text of it. */
function readJsonFile(value: unknown, name: string): Result<Record<string, unknown>> {
  if (isObject(value)) return { ok: true, value };
  if (typeof value !== "string") return { ok: false, error: `${name} must be the file's JSON` };
  if (value.length > MAX_FILE_CHARS) return { ok: false, error: `${name} is too large to be that file` };
  try {
    const parsed = JSON.parse(value);
    if (isObject(parsed)) return { ok: true, value: parsed };
  } catch { /* answered below */ }
  return { ok: false, error: `${name} is not valid JSON` };
}

/** The Android client of `google-services.json` for PPM's package, or why there is none. */
export function androidClientConfig(googleServices: Record<string, unknown>): Result<FcmAndroidConfig> {
  const project = isObject(googleServices.project_info) ? googleServices.project_info : null;
  const projectId = str(project?.project_id);
  const senderId = str(project?.project_number);
  if (!project || !projectId || !senderId) {
    return { ok: false, error: "google-services.json has no project_info: download it from the Firebase console's Android app" };
  }
  const clients = Array.isArray(googleServices.client) ? googleServices.client.filter(isObject) : [];
  const client = clients.find((c) => {
    const info = isObject(c.client_info) ? c.client_info : null;
    const android = isObject(info?.android_client_info) ? info.android_client_info : null;
    return str(android?.package_name) === FCM_ANDROID_PACKAGE;
  });
  if (!client) {
    return { ok: false, error: `google-services.json has no Android app with package name ${FCM_ANDROID_PACKAGE}: add one in the Firebase console and download the file again` };
  }
  const appId = str((client.client_info as Record<string, unknown>).mobilesdk_app_id);
  const keys = Array.isArray(client.api_key) ? client.api_key.filter(isObject) : [];
  const apiKey = str(keys[0]?.current_key);
  if (!appId || !apiKey) return { ok: false, error: `The ${FCM_ANDROID_PACKAGE} app in google-services.json has no app id or API key` };
  const storageBucket = str(project.storage_bucket);
  return { ok: true, value: { apiKey, appId, senderId, projectId, ...(storageBucket ? { storageBucket } : {}) } };
}

/** A service-account key file, with a private key WebCrypto can import. */
export async function parseServiceAccount(value: unknown): Promise<Result<FcmServiceAccount>> {
  const file = readJsonFile(value, "The service account key");
  if (!file.ok) return file;
  const sa = file.value;
  if (sa.type !== "service_account") {
    return { ok: false, error: "That is not a service account key: generate one under Project settings → Service accounts" };
  }
  for (const field of ["project_id", "client_email", "private_key"] as const) {
    if (!str(sa[field])) return { ok: false, error: `The service account key has no ${field}` };
  }
  try {
    await importServiceAccountKey(sa.private_key as string);
  } catch {
    return { ok: false, error: "The service account's private_key cannot be read" };
  }
  return { ok: true, value: sa as FcmServiceAccount };
}

/**
 * Check a `PUT /fcm` body against what is saved: a file left out keeps the saved one. Both must
 * be there afterwards, and both must name the same Firebase project.
 */
export async function validateFcmUpdate(
  body: { googleServices?: unknown; serviceAccount?: unknown } | null,
  current: FcmConfig | null,
): Promise<Result<FcmConfig>> {
  if (!body || (body.googleServices === undefined && body.serviceAccount === undefined)) {
    return { ok: false, error: "Add google-services.json and the service account key" };
  }
  let googleServices = current?.googleServices ?? null;
  if (body.googleServices !== undefined) {
    const file = readJsonFile(body.googleServices, "google-services.json");
    if (!file.ok) return file;
    googleServices = file.value;
  }
  let serviceAccount = current?.serviceAccount ?? null;
  if (body.serviceAccount !== undefined) {
    const parsed = await parseServiceAccount(body.serviceAccount);
    if (!parsed.ok) return parsed;
    serviceAccount = parsed.value;
  }
  if (!googleServices) return { ok: false, error: "Add google-services.json too" };
  if (!serviceAccount) return { ok: false, error: "Add the service account key too" };
  const android = androidClientConfig(googleServices);
  if (!android.ok) return android;
  if (android.value.projectId !== serviceAccount.project_id.trim()) {
    return {
      ok: false,
      error: `The two files are for different Firebase projects: google-services.json is for ${android.value.projectId}, the service account for ${serviceAccount.project_id}`,
    };
  }
  return { ok: true, value: { googleServices, serviceAccount } };
}

/** The saved config, or null when there is none or it no longer reads as one. */
export function loadFcmConfig(): FcmConfig | null {
  const raw = getConfigValue(FCM_ROW);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FcmConfig>;
    if (!isObject(parsed.googleServices) || !isObject(parsed.serviceAccount)) return null;
    if (parsed.serviceAccount.type !== "service_account") return null;
    if (!str(parsed.serviceAccount.project_id) || !str(parsed.serviceAccount.client_email) || !str(parsed.serviceAccount.private_key)) return null;
    return parsed as FcmConfig;
  } catch {
    return null;
  }
}

export function saveFcmConfig(config: FcmConfig): void {
  setConfigValue(FCM_ROW, JSON.stringify(config));
}

export function clearFcmConfig(): void {
  deleteConfigValue(FCM_ROW);
}

/** What any client may see: the public Android client config, never the service account. */
export function fcmStatus(config: FcmConfig | null = loadFcmConfig()): FcmStatus {
  if (!config) return { configured: false, android: null };
  const android = androidClientConfig(config.googleServices);
  if (!android.ok) return { configured: false, android: null };
  return { configured: true, projectId: android.value.projectId, android: android.value };
}
