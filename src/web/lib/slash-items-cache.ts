import { api, projectUrl } from "./api-client";
import type { SlashItem } from "@/components/chat/slash-command-picker";

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
export function fetchSlashItems(project: string, provider = "claude", sessionId?: string): Promise<SlashItemsPayload> {
  const key = keyFor(project, provider);
  let entry = projects.get(key);
  if (entry?.promise) return entry.promise;
  if (entry?.data && Date.now() < entry.expiresAt) return Promise.resolve(entry.data);
  if (!entry) { entry = { expiresAt: 0 }; projects.set(key, entry); }
  const owner = entry;
  const query = new URLSearchParams({ providerId: provider });
  if (sessionId) query.set("sessionId", sessionId);
  const promise = api.get<SlashItemsPayload>(`${projectUrl(project)}/chat/slash-items?${query}`)
    .then((data) => {
      const payload = { items: data.items ?? [], recentNames: data.recentNames ?? [] };
      if (projects.get(key) === owner) {
        owner.data = payload;
        owner.expiresAt = Date.now() + SLASH_ITEMS_TTL_MS;
        providers.set(provider, { items: payload.items.filter((item) => item.scope !== "project"), recentNames: [] });
        listeners.forEach((listener) => listener());
      }
      return payload;
    }).finally(() => { if (owner.promise === promise) owner.promise = undefined; });
  owner.promise = promise;
  return promise;
}
/** Invalidate once before notifying mounted tabs; keep data visible during refresh. */
export function clearSlashItemsCache(project?: string): void {
  if (!project) { projects.clear(); providers.clear(); return; }
  for (const [key, entry] of projects) projects.set(key, { data: entry.data, expiresAt: 0 });
}
