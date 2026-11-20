/**
 * Which paths in a Telegram message may be links to PPM's file browser, as
 * `primeTelegramPathLinks` last decided (`telegram-path-links.ts`). The formatter reads it
 * synchronously; nothing here touches the disk, so the formatter stays free of it.
 */

export const PATH_LINK_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

const entries = new Map<string, { link: string | null; at: number }>();

export const pathLinkCache = {
  get(path: string): { link: string | null; at: number } | undefined {
    return entries.get(path);
  },
  set(path: string, link: string | null, at = Date.now()): void {
    entries.delete(path);
    entries.set(path, { link, at });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  },
  clear(): void {
    entries.clear();
  },
};

/** The `/files?path=` link for a path that was primed and allowed, or null. */
export function telegramPathLink(path: string): string | null {
  const held = entries.get(path);
  if (!held || Date.now() - held.at >= PATH_LINK_TTL_MS) return null;
  return held.link;
}
