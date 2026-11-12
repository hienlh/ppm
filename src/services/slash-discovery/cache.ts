import type { SlashItem } from "./types.ts";

interface CacheEntry {
  items: SlashItem[];
  cachedAt: number;
}

/** In-memory cache keyed by projectPath */
const cache = new Map<string, CacheEntry>();

/** Default TTL: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Get cached items if still valid, or null */
export function getCached(projectPath: string, providerId = "claude"): SlashItem[] | null {
  const key = `${projectPath}::${providerId}`;
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > DEFAULT_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.items;
}

/** Store items in cache */
export function setCache(projectPath: string, items: SlashItem[], providerId = "claude"): void {
  cache.set(`${projectPath}::${providerId}`, { items, cachedAt: Date.now() });
}

/** Invalidate cache for a specific project */
export function invalidateCache(projectPath: string): void {
  cache.delete(projectPath);
  for (const key of cache.keys()) {
    if (key.startsWith(`${projectPath}::`)) cache.delete(key);
  }
}

/** Invalidate all cached entries */
export function invalidateAll(): void {
  cache.clear();
}
