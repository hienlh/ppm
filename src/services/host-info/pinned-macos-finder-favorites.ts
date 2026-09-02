/** macOS Finder sidebar Favorites. The container file
 *  (`~/Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.FavoriteItems.sfl{2,3,4}`)
 *  is an NSKeyedArchiver binary plist; `plutil -convert xml1` turns it into
 *  readable XML without extra permissions, but the payload is still an
 *  archived object graph (`$objects` array + `CF$UID` references), not plain
 *  key/value pairs. Each favorite item is a dict carrying `Name` plus either
 *  a direct `URL` (fast path) or a `Bookmark` binary blob that must be
 *  decoded by `apple-bookmark-decoder.ts` (slow path, used when the item has
 *  moved since it was pinned).
 *
 *  UNVERIFIED against a real macOS sample — field names/nesting come from
 *  public reverse-engineering (see plans research), not Apple docs. Kept
 *  enabled; any parse failure degrades to a `warnings[]` entry instead of
 *  blocking the whole `/api/system/host` response. Also gated by TCC: the
 *  sharedfilelist directory needs Full Disk Access for an unsandboxed
 *  process, so a denied read must surface as an actionable warning, not a
 *  silent empty list. */
import * as fsp from "node:fs/promises";
import type { PinnedFolder } from "../../types/system.ts";
import { defaultRunner, type Runner } from "./spawn-runner.ts";
import { parsePlistXml, type PlistValue } from "./apple-plist-xml-parser.ts";
import { decodeBookmarkPath } from "./apple-bookmark-decoder.ts";

export interface FinderFavoritesDeps {
  run: Runner;
  fileExists: (path: string) => Promise<boolean>;
}

const defaultDeps: FinderFavoritesDeps = {
  run: defaultRunner,
  fileExists: async (p) => {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

const SFL_EXTENSIONS = ["sfl4", "sfl3", "sfl2"]; // newest naming first (macOS 26, 13-25, <=12)

interface RawFavorite {
  name: string;
  path: string;
}

function isUidMarker(v: PlistValue): v is { "CF$UID": number } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !Buffer.isBuffer(v) &&
    Object.keys(v).length === 1 &&
    typeof (v as Record<string, PlistValue>)["CF$UID"] === "number"
  );
}

function resolveUid(objects: PlistValue[], v: PlistValue): PlistValue | null {
  return isUidMarker(v) ? (objects[v["CF$UID"]] ?? null) : v;
}

function asRecord(v: PlistValue | null): Record<string, PlistValue> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v)
    ? (v as Record<string, PlistValue>)
    : null;
}

/** NSDictionary is archived as parallel `NS.keys`/`NS.objects` UID-ref arrays, not plain key/value pairs. */
function resolveNsKeyedDict(raw: PlistValue | null, objects: PlistValue[]): Record<string, PlistValue> | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const nsKeys = rec["NS.keys"];
  const nsObjects = rec["NS.objects"];
  if (!Array.isArray(nsKeys) || !Array.isArray(nsObjects) || nsKeys.length !== nsObjects.length) return rec;
  const out: Record<string, PlistValue> = {};
  for (let i = 0; i < nsKeys.length; i++) {
    const key = resolveUid(objects, nsKeys[i]!);
    if (typeof key === "string") out[key] = nsObjects[i]!;
  }
  return out;
}

function extractFavorites(objects: PlistValue[], warnings: string[]): RawFavorite[] {
  const out: RawFavorite[] = [];
  for (const raw of objects) {
    const item = resolveNsKeyedDict(raw, objects);
    if (!item || item["Name"] === undefined) continue;
    const name = resolveUid(objects, item["Name"]);
    if (typeof name !== "string") continue;

    let path: string | null = null;

    // Fast path: NSURL already carries a file:// string.
    if (item["URL"] !== undefined) {
      const urlDict = resolveNsKeyedDict(resolveUid(objects, item["URL"]), objects);
      const relative = urlDict?.["NS.relative"];
      const relativeStr = relative !== undefined ? resolveUid(objects, relative) : undefined;
      if (typeof relativeStr === "string" && relativeStr.startsWith("file://")) {
        try {
          path = decodeURIComponent(relativeStr.replace(/^file:\/\//, ""));
        } catch {
          // Malformed percent-encoding — fall through to the Bookmark blob below.
        }
      }
    }

    // Slow path: decode the raw Bookmark blob (used once the item has moved).
    if (!path && item["Bookmark"] !== undefined) {
      const bookmark = resolveUid(objects, item["Bookmark"]);
      if (Buffer.isBuffer(bookmark)) {
        try {
          path = decodeBookmarkPath(bookmark);
        } catch (e) {
          warnings.push(`pinned: Finder Favorites bookmark decode failed for "${name}" (${(e as Error)?.message ?? e})`);
        }
      }
    }

    if (path) out.push({ name, path });
  }
  return out;
}

/** Read Finder sidebar Favorites, appending any failure to the shared `warnings` array (never throws). */
export async function getMacosFinderFavoritesPinned(
  homedir: string,
  warnings: string[],
  overrides: Partial<FinderFavoritesDeps> = {},
): Promise<PinnedFolder[]> {
  const deps: FinderFavoritesDeps = { ...defaultDeps, ...overrides };
  const dir = `${homedir}/Library/Application Support/com.apple.sharedfilelist`;

  let file: string | null = null;
  for (const ext of SFL_EXTENSIONS) {
    const candidate = `${dir}/com.apple.LSSharedFileList.FavoriteItems.${ext}`;
    if (await deps.fileExists(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) {
    warnings.push(
      "pinned: Finder Favorites file not found (.sfl2/.sfl3/.sfl4) — grant Full Disk Access to the terminal/ppm binary if it should exist",
    );
    return [];
  }

  let xml: string;
  try {
    const res = await deps.run(["plutil", "-convert", "xml1", "-o", "-", file], 5000);
    if (res.timedOut || res.code !== 0) {
      warnings.push(
        `pinned: Finder Favorites: plutil ${res.timedOut ? "timed out" : `exited ${res.code}`} — grant Full Disk Access to the terminal/ppm binary`,
      );
      return [];
    }
    xml = res.stdout;
  } catch (e) {
    warnings.push(`pinned: Finder Favorites plutil failed (${(e as Error)?.message ?? e})`);
    return [];
  }

  try {
    const plist = parsePlistXml(xml);
    const objects = asRecord(plist)?.["$objects"];
    if (!Array.isArray(objects)) throw new Error("no $objects array in NSKeyedArchiver container");
    return extractFavorites(objects, warnings).map((f) => ({ ...f, source: "finder-favorites" as const }));
  } catch (e) {
    warnings.push(
      `pinned: Finder Favorites parse failed (${(e as Error)?.message ?? e}) — reverse-engineered format, verify against a real macOS sample`,
    );
    return [];
  }
}
