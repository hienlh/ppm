import { api, projectUrl } from "@/lib/api-client";
import type { SlashItem } from "@/components/chat/slash-command-picker";

export interface SlashItemsPayload {
  items: SlashItem[];
  recentNames: string[];
}

/**
 * Per-project cache for the slash-command / skill list.
 *
 * The list is identical for every chat tab in a project but was fetched once per
 * `MessageInput` mount — 23 KB per newly opened tab. The slash picker renders
 * `null` until the list resolves, so that fetch sat directly in front of the
 * first `/` the user typed in every new tab.
 *
 * Caches the in-flight promise (not just the result) so simultaneous mounts share
 * one request. Session-scoped: a reload starts empty.
 */
const cache = new Map<string, Promise<SlashItemsPayload>>();

export function fetchSlashItems(projectName: string): Promise<SlashItemsPayload> {
  const cached = cache.get(projectName);
  if (cached) return cached;

  const p = api
    .get<SlashItemsPayload>(`${projectUrl(projectName)}/chat/slash-items`)
    .then((data) => ({ items: data.items ?? [], recentNames: data.recentNames ?? [] }))
    .catch((e) => {
      // Don't cache failures — the next mount should retry.
      cache.delete(projectName);
      throw e;
    });

  cache.set(projectName, p);
  return p;
}

/**
 * Drop cached lists so the next mount refetches. Called when the user hits the
 * refresh button in the picker, which also invalidates the server-side cache.
 */
export function clearSlashItemsCache(projectName?: string): void {
  if (projectName) cache.delete(projectName);
  else cache.clear();
}
