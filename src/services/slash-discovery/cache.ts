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
export function getCached(projectPath: string): SlashItem[] | null {
  const entry = cache.get(projectPath);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > DEFAULT_TTL_MS) {
    cache.delete(projectPath);
    return null;
  }
  return entry.items;
}

/** Store items in cache */
export function setCache(projectPath: string, items: SlashItem[]): void {
  cache.set(projectPath, { items, cachedAt: Date.now() });
}

/** Invalidate cache for a specific project */
export function invalidateCache(projectPath: string): void {
  cache.delete(projectPath);
}

/** Invalidate all cached entries */
export function invalidateAll(): void {
  cache.clear();
}
