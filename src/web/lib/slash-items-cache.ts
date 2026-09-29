import { api, projectUrl } from "./api-client";
import type { SlashItem } from "@/components/chat/slash-command-picker";
import { idbGetEntry, idbSet } from "./browser-cache/idb-keyval-cache";
import { readChatPreparationSettings } from "./chat-preference-local-cache";
import { projectCacheId, slash as slashKey, type ProjectCacheRef } from "./browser-cache/cache-keys";
import { registerProjectHydrator } from "./browser-cache/project-cache-hydration";
import { registerCacheReset } from "./browser-cache/wipe-browser-caches";

export interface SlashItemsPayload { items: SlashItem[]; recentNames: string[] }
export const SLASH_ITEMS_TTL_MS = 30 * 60_000;
type Entry = { data?: SlashItemsPayload; promise?: Promise<SlashItemsPayload>; expiresAt: number };
const projects = new Map<string, Entry>();
const providers = new Map<string, SlashItemsPayload>();
const listeners = new Set<() => void>();
const keyFor = (project: string, provider = "claude") => JSON.stringify([project, provider]);

/** Provider-wide skills are immediately usable; project overrides stay local. */
export function getCachedSlashItems(project: string, provider = "claude"): SlashItemsPayload | undefined {
  return projects.get(keyFor(project, provider))?.data ?? providers.get(provider);
}
export function subscribeSlashItems(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function fetchFromServer(project: string, provider: string, sessionId?: string): Promise<SlashItemsPayload> {
  const query = new URLSearchParams({ providerId: provider });
  if (sessionId) query.set("sessionId", sessionId);
  return api.get<SlashItemsPayload>(`${projectUrl(project)}/chat/slash-items?${query}`)
    .then((data) => ({ items: data.items ?? [], recentNames: data.recentNames ?? [] }));
}

/** Owns `entry.promise` for `key` until `request` settles — shared by a plain network
 * fetch and a prepare-registered join so both update the provider-wide entry and
 * notify listeners the same way once they land. */
function settle(key: string, entry: Entry, provider: string, request: Promise<SlashItemsPayload>): Promise<SlashItemsPayload> {
  const promise = request.then((payload) => {
    if (projects.get(key) === entry) {
      entry.data = payload;
      entry.expiresAt = Date.now() + SLASH_ITEMS_TTL_MS;
      providers.set(provider, { items: payload.items.filter((item) => item.scope !== "project"), recentNames: [] });
      listeners.forEach((listener) => listener());
    }
    return payload;
  }).finally(() => { if (entry.promise === promise) entry.promise = undefined; });
  entry.promise = promise;
  return promise;
}

export function fetchSlashItems(project: string, provider = "claude", sessionId?: string): Promise<SlashItemsPayload> {
  const key = keyFor(project, provider);
  const entry = projects.get(key);
  if (entry?.promise) return entry.promise;
  if (entry?.data && Date.now() < entry.expiresAt) return Promise.resolve(entry.data);
  const owner = entry ?? { expiresAt: 0 };
  if (!entry) projects.set(key, owner);
  return settle(key, owner, provider, fetchFromServer(project, provider, sessionId));
}

/**
 * Joins a `/chat/prepare` request already in flight for this (project, provider), so the
 * composer's own mount-time `fetchSlashItems` reuses its slash part instead of firing a
 * second GET. Falls back to the real request when prepare's slash part came back null
 * (its own budget ran out server-side).
 *
 * Only useful for the same key a concurrent `fetchSlashItems` will actually be called
 * with — a caller that does not yet know the resolved provider has nothing to register.
 */
export function registerPendingSlash(project: string, provider: string, promise: Promise<SlashItemsPayload | null>): void {
  const key = keyFor(project, provider);
  const existing = projects.get(key);
  if (existing?.promise || (existing?.data && Date.now() < existing.expiresAt)) return;
  const owner = existing ?? { expiresAt: 0 };
  if (!existing) projects.set(key, owner);
  settle(key, owner, provider, promise.then((payload) => payload ?? fetchFromServer(project, provider)));
}

/** Seeds a provider's slash list straight from a `/chat/prepare` response — no GET. */
export function seedSlashItems(project: ProjectCacheRef, provider: string, payload: SlashItemsPayload): void {
  const key = keyFor(project.name, provider);
  projects.set(key, { data: payload, expiresAt: Date.now() + SLASH_ITEMS_TTL_MS });
  providers.set(provider, { items: payload.items.filter((item) => item.scope !== "project"), recentNames: [] });
  listeners.forEach((listener) => listener());
  void idbSet(slashKey(projectCacheId(project), provider), payload);
}

export function clearSlashItemsCache(project?: string): void {
  if (!project) { projects.clear(); providers.clear(); return; }
  for (const [key, entry] of projects) projects.set(key, { data: entry.data, expiresAt: 0 });
}

/**
 * Fills a (project, provider) entry from IndexedDB — stale-while-revalidate.
 *
 * The list is shown as soon as it lands, but it keeps the age it was stored with
 * (`expiresAt = at + TTL`), so a list written days ago is already expired: the next
 * `fetchSlashItems` or `registerPendingSlash` still refreshes it instead of trusting
 * it for another half hour. An entry that already has a request in flight but no data
 * yet — the normal order on a project switch, where the tabs mount (and register their
 * prepare) right after hydration starts — still gets the data to show meanwhile; only
 * an entry that already holds data is left alone.
 */
async function hydrateSlashEntry(project: ProjectCacheRef, provider: string): Promise<void> {
  const cached = await idbGetEntry<SlashItemsPayload>(slashKey(projectCacheId(project), provider));
  if (!cached || !Array.isArray(cached.data?.items)) return;
  const key = keyFor(project.name, provider);
  const entry = projects.get(key);
  if (entry?.data) return; // a network answer (or a seed) already landed first
  const expiresAt = cached.at + SLASH_ITEMS_TTL_MS;
  if (entry) {
    entry.data = cached.data;
    entry.expiresAt = expiresAt;
  } else {
    projects.set(key, { data: cached.data, expiresAt });
  }
  listeners.forEach((listener) => listener());
}

// Warms the list on project switch, ahead of any tab mounting, for the providers a
// new tab is most likely to open on: "claude" and whatever the cached settings name as
// the default. A tab on any other provider hydrates the ordinary way, through its own
// `fetchSlashItems` call.
registerProjectHydrator(async (project) => {
  const likely = new Set(["claude", readChatPreparationSettings()?.default_provider ?? "claude"]);
  await Promise.all([...likely].map((provider) => hydrateSlashEntry(project, provider)));
});

registerCacheReset(() => {
  projects.clear();
  providers.clear();
});
