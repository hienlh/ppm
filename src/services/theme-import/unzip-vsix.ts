import { unzip } from "unzipit";

/**
 * Extract theme JSON documents from a .vsix (a zip). Hardened against
 * zip-slip (path escape), zip-bombs (uncompressed-size sum), and entry floods.
 * Only reads files referenced by `extension/package.json`'s contributes.themes.
 */

const MAX_TOTAL_UNCOMPRESSED = 50 * 1024 * 1024; // 50 MB
const MAX_ENTRIES = 500;
/** Cap on the ACTUAL decompressed bytes of any single entry we read. */
const MAX_ENTRY_BYTES = 5 * 1024 * 1024; // 5 MB

export interface ExtractedTheme {
  label: string;
  uiTheme?: string;
  json: Record<string, unknown>;
}

/** Reject entry names that could escape the archive root. Exported for tests. */
export function isUnsafeEntryName(name: string): boolean {
  if (name.includes("..")) return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;
  if (/^[a-zA-Z]:[/\\]/.test(name)) return true; // Windows absolute
  return false;
}

/** Normalize a package.json-relative theme path to an `extension/`-rooted entry name. */
function resolveThemeEntryName(themePath: string): string | null {
  let p = themePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isUnsafeEntryName(p)) return null;
  const full = p.startsWith("extension/") ? p : `extension/${p}`;
  // Canonical check: no segment may be `..`
  if (full.split("/").some((seg) => seg === "..")) return null;
  return full;
}

/**
 * Read + JSON-parse an entry, enforcing the ACTUAL decompressed byte length
 * (not the zip's self-declared `entry.size`, which an attacker controls).
 */
async function readJsonCapped(entry: { arrayBuffer: () => Promise<ArrayBuffer> }): Promise<Record<string, unknown>> {
  const buf = await entry.arrayBuffer();
  if (buf.byteLength > MAX_ENTRY_BYTES) throw new Error("Archive entry too large when decompressed");
  return JSON.parse(new TextDecoder().decode(buf)) as Record<string, unknown>;
}

export async function extractVsixThemes(bytes: Uint8Array): Promise<ExtractedTheme[]> {
  const { entries } = await unzip(bytes);
  const names = Object.keys(entries);

  if (names.length > MAX_ENTRIES) throw new Error("Archive has too many entries");

  // First gate: declared-size sum (cheap, catches obvious bombs). The real
  // enforcement is the actual-byte-length cap in readJsonCapped below, since
  // declared sizes are attacker-controlled.
  let totalSize = 0;
  for (const name of names) {
    const entry = entries[name];
    if (isUnsafeEntryName(name)) throw new Error(`Unsafe entry path: ${name}`);
    totalSize += entry?.size ?? 0;
    if (totalSize > MAX_TOTAL_UNCOMPRESSED) throw new Error("Archive too large when decompressed");
  }

  const pkgEntry = entries["extension/package.json"];
  if (!pkgEntry) throw new Error("Not a valid extension: missing extension/package.json");

  const pkg = (await readJsonCapped(pkgEntry)) as {
    contributes?: { themes?: Array<{ label?: string; uiTheme?: string; path?: string }> };
  };
  const contributed = pkg?.contributes?.themes;
  if (!Array.isArray(contributed) || contributed.length === 0) {
    throw new Error("Extension contributes no themes");
  }

  const out: ExtractedTheme[] = [];
  for (const t of contributed) {
    if (!t.path) continue;
    const entryName = resolveThemeEntryName(t.path);
    if (!entryName) continue;
    const themeEntry = entries[entryName];
    if (!themeEntry) continue;
    try {
      const json = await readJsonCapped(themeEntry);
      out.push({ label: t.label ?? "Imported Theme", uiTheme: t.uiTheme, json });
    } catch {
      // skip malformed / oversized theme file
    }
  }

  if (out.length === 0) throw new Error("No readable themes found in extension");
  return out;
}
