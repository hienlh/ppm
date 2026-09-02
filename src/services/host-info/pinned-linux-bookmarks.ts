/** Linux pinned folders: GTK3/GTK4 bookmarks (Nautilus, `~/.config/gtk-3.0/bookmarks`,
 *  falling back to `gtk-4.0` since some sources report GTK4-only apps write
 *  there) and KDE Places (Dolphin, `~/.local/share/user-places.xbel`). Both
 *  formats are plain text/XML, stable for 15+ years — no reverse-engineering
 *  needed, so a tolerant regex parse is used instead of pulling in an XML lib. */
import * as fsp from "node:fs/promises";
import type { PinnedFolder } from "../../types/system.ts";

export interface LinuxBookmarkDeps {
  readFile: (path: string) => Promise<string>;
}

const defaultDeps: LinuxBookmarkDeps = { readFile: (p) => fsp.readFile(p, "utf-8") };

interface RawBookmark {
  name: string;
  path: string;
}

function parseGtkBookmarks(raw: string): RawBookmark[] {
  const out: RawBookmark[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^file:\/\/(\S+)(?: (.*))?$/);
    if (!m) continue; // malformed line or a non-file:// bookmark (e.g. network location) — skip, not fatal
    const path = decodeURIComponent(m[1]!);
    const name = m[2] ? decodeURIComponent(m[2]) : (path.split("/").filter(Boolean).pop() ?? path);
    out.push({ name, path });
  }
  return out;
}

async function getGtkPinned(deps: LinuxBookmarkDeps, homedir: string, warnings: string[]): Promise<PinnedFolder[]> {
  const candidates = [`${homedir}/.config/gtk-3.0/bookmarks`, `${homedir}/.config/gtk-4.0/bookmarks`];
  for (const file of candidates) {
    try {
      const raw = await deps.readFile(file);
      return parseGtkBookmarks(raw).map((b) => ({ ...b, source: "gtk" as const }));
    } catch {
      // try the next candidate path
    }
  }
  warnings.push("pinned: no GTK bookmarks file found (gtk-3.0/gtk-4.0)");
  return [];
}

function parseKdePlaces(raw: string): RawBookmark[] {
  const out: RawBookmark[] = [];
  const re = /<bookmark\s+href="file:\/\/(.*?)"[^>]*>[\s\S]*?<title>(.*?)<\/title>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out.push({ path: decodeURIComponent(m[1]!), name: decodeURIComponent(m[2]!) });
  }
  return out;
}

async function getKdePinned(deps: LinuxBookmarkDeps, homedir: string, warnings: string[]): Promise<PinnedFolder[]> {
  try {
    const raw = await deps.readFile(`${homedir}/.local/share/user-places.xbel`);
    return parseKdePlaces(raw).map((b) => ({ ...b, source: "kde" as const }));
  } catch (e) {
    warnings.push(`pinned: KDE user-places.xbel not found (${(e as Error)?.message ?? e})`);
    return [];
  }
}

/** GTK (Nautilus) + KDE (Dolphin) pinned folders, deduped by path (GTK wins on conflict).
 *  Appends any failure to the shared `warnings` array (never throws). */
export async function getLinuxPinned(
  homedir: string,
  warnings: string[],
  overrides: Partial<LinuxBookmarkDeps> = {},
): Promise<PinnedFolder[]> {
  const deps: LinuxBookmarkDeps = { ...defaultDeps, ...overrides };
  const [gtk, kde] = await Promise.all([
    getGtkPinned(deps, homedir, warnings),
    getKdePinned(deps, homedir, warnings),
  ]);

  const seen = new Set<string>();
  const result: PinnedFolder[] = [];
  for (const item of [...gtk, ...kde]) {
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    result.push(item);
  }
  return result;
}
