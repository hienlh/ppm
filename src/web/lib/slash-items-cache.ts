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
 *
 * Keyed by project AND session, because the list is no longer identical across a
 * project's tabs: a provider that owns its skill runtime answers for itself, so a
 * codex tab and a Claude tab in one project get different lists — and two codex
 * tabs can differ too when they are bound to different accounts.
 */
const cache = new Map<string, Promise<SlashItemsPayload>>();

export function fetchSlashItems(
  projectName: string,
  providerId?: string,
  sessionId?: string,
): Promise<SlashItemsPayload> {
  const key = `${projectName}\0${providerId ?? ""}\0${sessionId ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const query = new URLSearchParams();
  if (providerId) query.set("providerId", providerId);
  if (sessionId) query.set("sessionId", sessionId);
  const qs = query.size > 0 ? `?${query}` : "";

  const p = api
    .get<SlashItemsPayload>(`${projectUrl(projectName)}/chat/slash-items${qs}`)
    .then((data) => ({ items: data.items ?? [], recentNames: data.recentNames ?? [] }))
    .catch((e) => {
      // Don't cache failures — the next mount should retry.
      cache.delete(key);
      throw e;
    });

  cache.set(key, p);
  return p;
}

/**
 * Drop cached lists so the next mount refetches. Called when the user hits the
 * refresh button in the picker, which also invalidates the server-side cache.
 */
export function clearSlashItemsCache(projectName?: string): void {
  if (!projectName) { cache.clear(); return; }
  // One project now holds several keys (one per provider/session), so a targeted
  // refresh has to drop every entry belonging to it, not just an exact match.
  const prefix = `${projectName}\0`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
