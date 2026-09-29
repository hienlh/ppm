/**
 * localStorage cache for the settings a new chat tab needs before it can
 * resolve its provider and permission mode.
 *
 * `/api/settings/ai` is global, not per project, so the settings subset is
 * cached under one global key. The provider *list* (`/chat/providers`) is
 * project-scoped, so it is cached per `projectCacheId` instead.
 *
 * Both are read synchronously so a tab can render before any network
 * response arrives, and both are shape-validated on read: anything pulled
 * back out of localStorage may be stale, hand-edited, or written by an
 * older build. Only the fields a new tab needs are ever stored — never
 * account ids, labels, API keys, or anything else from the full settings
 * object (see `AISettings` in `api-settings.ts`).
 */
import { providers as providersKey } from "./browser-cache/cache-keys";
import type { ChatPreparationProviderSettings, ChatPreparationSettings } from "../../shared/chat-preparation-settings";

export const CHAT_PREF_STORAGE_KEY = "ppm-chat-pref";

export interface CachedChatProvider {
  id: string;
  name: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrows an arbitrary settings-shaped value down to only the fields this
 * cache is allowed to hold, dropping everything else even if the caller
 * passed a full `AISettings` object. Returns null when the shape is unusable. */
function sanitizeSettings(input: unknown): ChatPreparationSettings | null {
  if (!isPlainObject(input) || typeof input.default_provider !== "string") return null;
  const mode = input.new_chat_provider_mode;
  if (mode !== undefined && mode !== "default" && mode !== "follow-focus") return null;

  const providers: Record<string, ChatPreparationProviderSettings> = {};
  if (isPlainObject(input.providers)) {
    for (const [id, value] of Object.entries(input.providers)) {
      if (!isPlainObject(value)) continue;
      providers[id] = typeof value.permission_mode === "string"
        ? { permission_mode: value.permission_mode }
        : {};
    }
  }
  return { default_provider: input.default_provider, new_chat_provider_mode: mode, providers };
}

export function readChatPreparationSettings(): ChatPreparationSettings | null {
  try {
    const raw = localStorage.getItem(CHAT_PREF_STORAGE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeChatPreparationSettings(settings: ChatPreparationSettings): void {
  const clean = sanitizeSettings(settings);
  if (!clean) return;
  try {
    localStorage.setItem(CHAT_PREF_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Storage full or blocked — the cache is best-effort.
  }
}

function sanitizeProviders(input: unknown): CachedChatProvider[] | null {
  if (!Array.isArray(input)) return null;
  const out: CachedChatProvider[] = [];
  for (const entry of input) {
    if (isPlainObject(entry) && typeof entry.id === "string" && typeof entry.name === "string") {
      out.push({ id: entry.id, name: entry.name });
    }
  }
  return out;
}

export function readChatProviders(projectId: string): CachedChatProvider[] | null {
  try {
    const raw = localStorage.getItem(providersKey(projectId));
    return raw ? sanitizeProviders(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeChatProviders(projectId: string, list: CachedChatProvider[]): void {
  const clean = sanitizeProviders(list);
  if (!clean) return;
  try {
    localStorage.setItem(providersKey(projectId), JSON.stringify(clean));
  } catch {
    // ignore
  }
}
