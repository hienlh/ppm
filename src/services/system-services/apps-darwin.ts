/**
 * The Apps page on macOS: which applications are running, and which pids are theirs.
 *
 * An app is an application bundle, which is how the Dock and Activity Monitor see
 * one, and a process belongs to the bundle its executable runs from. `ps` already
 * prints that path, so nothing is matched by name: an Electron app's renderers run
 * from `<App>.app/Contents/Frameworks/<App> Helper (Renderer).app/…`, inside the
 * app's own bundle, and fold into it.
 *
 * Which bundle a process belongs to, and whether that bundle is an app anyone
 * would call running, takes five rules, each from a case on a real machine:
 *
 * - A bundle inside a `.framework` is part of the framework, not an app. Chrome's
 *   helpers live in `Google Chrome Framework.framework/…/Helpers/`, and Python's
 *   interpreter runs from `Python.framework/…/Python.app`.
 * - The innermost REGULAR app wins (neither LSUIElement nor LSBackgroundOnly), else
 *   the outermost. Simulator runs from inside Xcode and is an app of its own, while
 *   an Electron app's helpers are LSUIElement bundles inside it and belong to it.
 * - An app extension never lists an app by itself. macOS runs the widgets of
 *   Clock, Weather and Calendar with none of them open, so an extension counts
 *   only once its app has a process of its own.
 * - Under /System only the application folders list, and Finder: the rest of
 *   CoreServices is the Dock, Control Center, Spotlight and the rest of macOS.
 * - Anything in an Applications folder lists; nothing under a Library folder does
 *   (those are an app's agents and updaters); anywhere else, only a regular app.
 *
 * Info.plists are read in-process in either format and cached against their mtime,
 * so a tick stats each running bundle once and parses one only after an update.
 */
import { readFileSync, statSync } from "node:fs";
import type { AppInfo } from "../../types/system-metrics.ts";
import { parsePlistBytes } from "../system-metrics/plist-binary.ts";
import { isPlistDict, plistString, type PlistValue } from "../system-metrics/plist-xml.ts";
import { primaryPids, type AppProcess } from "./apps-linux.ts";

/** An Info.plist is a few KB. One this size is not worth parsing every tick. */
export const MAX_INFO_PLIST_BYTES = 1024 * 1024;

const SYSTEM_APP_DIRS = [
  "/System/Applications/",
  // Safari ships in a cryptex, updated apart from the OS, since macOS 13. Safari
  // itself runs from the first path; its agents run through the symlink to it.
  "/System/Volumes/Preboot/Cryptexes/App/System/Applications/",
  "/System/Cryptexes/App/System/Applications/",
  "/System/Library/CoreServices/Applications/",
];
const FINDER = "/System/Library/CoreServices/Finder.app";
const APPLICATIONS_DIR = /^\/(?:Users\/[^/]+\/)?Applications\//;
const LIBRARY_DIR = /^\/(?:Users\/[^/]+\/)?Library\//;

export interface BundleFs {
  /** A regular file's mtime and size, or null when it is missing or not a file. */
  stat(path: string): { mtimeMs: number; size: number } | null;
  read(path: string): Uint8Array | null;
}

export const realBundleFs: BundleFs = {
  stat: (path) => {
    try {
      const s = statSync(path);
      return s.isFile() ? { mtimeMs: s.mtimeMs, size: s.size } : null;
    } catch {
      return null;
    }
  },
  read: (path) => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  },
};

/** The app bundles an executable runs from. */
export interface ExecutableBundles {
  /** Outermost first. */
  apps: string[];
  /** It runs from an app extension (`.appex`) inside one of them. */
  extension: boolean;
}

/**
 * The app bundles an absolute executable path runs from, or null when it runs from
 * none. A bundle counts only where the path goes on into its `Contents`: a folder
 * that is merely named `Foo.app` holds no app.
 */
export function bundlesOf(exePath: string): ExecutableBundles | null {
  if (!exePath.startsWith("/")) return null;
  const parts = exePath.split("/");
  const apps: string[] = [];
  let extension = false;
  let inFramework = false;
  for (let i = 1; i < parts.length - 1; i++) {
    const name = parts[i]!.toLowerCase();
    if (name.endsWith(".framework")) {
      inFramework = true;
      continue;
    }
    if (parts[i + 1] !== "Contents") continue;
    if (name.endsWith(".app") && !inFramework) apps.push(parts.slice(0, i + 1).join("/"));
    else if (name.endsWith(".appex") && apps.length > 0) extension = true;
  }
  return apps.length > 0 ? { apps, extension } : null;
}

/** Whether a bundle at this path may be listed, given whether it is a regular app. */
export function isListable(bundle: string, regular: boolean): boolean {
  if (bundle === FINDER || SYSTEM_APP_DIRS.some((dir) => bundle.startsWith(dir))) return true;
  if (bundle.startsWith("/System/")) return false;
  if (APPLICATIONS_DIR.test(bundle)) return true;
  if (LIBRARY_DIR.test(bundle)) return false;
  // Downloads, a mounted disk image, an App Translocation copy: an app someone
  // opened, as long as it is one with a window to open.
  return regular;
}

/** What an Info.plist says about its app, as far as listing it goes. */
export interface BundleInfo {
  /** CFBundleIdentifier. A bundle without one is not an app LaunchServices would run. */
  id: string;
  name: string;
  /** Neither menu-bar-only (LSUIElement) nor faceless (LSBackgroundOnly). */
  regular: boolean;
  /** The icon's file name in `Contents/Resources`, when it declares one that exists. */
  iconFile: string | null;
}

/** An Info.plist's view of its bundle, or null when it does not describe an app. */
export function bundleInfo(bundle: string, plist: PlistValue | undefined, fs: Pick<BundleFs, "stat">): BundleInfo | null {
  if (!isPlistDict(plist)) return null;
  const id = text(plist.CFBundleIdentifier);
  if (!id) return null;
  const folder = bundle.slice(bundle.lastIndexOf("/") + 1).replace(/\.app$/i, "");
  return {
    id,
    name: text(plist.CFBundleDisplayName) ?? text(plist.CFBundleName) ?? folder,
    regular: !flag(plist.LSUIElement) && !flag(plist.LSBackgroundOnly),
    iconFile: iconFileOf(bundle, text(plist.CFBundleIconFile), fs),
  };
}

function text(v: PlistValue | undefined): string | undefined {
  const s = plistString(v)?.trim();
  return s ? s : undefined;
}

/** Info.plists write a boolean key as `<true/>`, as `<integer>1</integer>` or as `<string>1</string>`. */
function flag(v: PlistValue | undefined): boolean {
  if (typeof v === "string") return /^(?:1|yes|true)$/i.test(v.trim());
  return v === true || v === 1;
}

/**
 * The declared icon's file, as LaunchServices finds it: the name as written, or
 * with `.icns` added when that is how it is stored ("AppIcon" is AppIcon.icns).
 * The name comes from the bundle, so it may not step out of its Resources folder.
 */
function iconFileOf(bundle: string, declared: string | undefined, fs: Pick<BundleFs, "stat">): string | null {
  if (!declared || declared.includes("/") || declared.includes("..")) return null;
  const names = declared.toLowerCase().endsWith(".icns") ? [declared] : [declared, `${declared}.icns`];
  return names.find((name) => fs.stat(`${bundle}/Contents/Resources/${name}`) !== null) ?? null;
}

/** Where a listed app's icon is, for the icon route. */
export interface AppIconSource {
  bundle: string;
  iconPath: string;
}

export interface DarwinAppList {
  apps: AppInfo[];
  /** id to icon, for the listed apps that have one. */
  icons: Map<string, AppIconSource>;
}

/**
 * Apps with at least one live process of their own, name-sorted. `lookup` reads a
 * bundle's Info.plist; null means it does not describe an app.
 *
 * Two copies of one app (one in Applications, one in Downloads) are one app: the
 * first copy seen gives the name and icon, and both copies' pids count.
 */
export function collectDarwinApps(
  processes: readonly AppProcess[],
  lookup: (bundle: string) => BundleInfo | null,
): DarwinAppList {
  const found = new Map<string, { bundle: string; info: BundleInfo; pids: number[]; ownProcess: boolean }>();
  for (const proc of processes) {
    const where = proc.exePath ? bundlesOf(proc.exePath) : null;
    const app = where ? appOf(where.apps, lookup) : null;
    if (!where || !app || !isListable(app.bundle, app.info.regular)) continue;
    const entry = found.get(app.info.id) ?? { ...app, pids: [], ownProcess: false };
    found.set(app.info.id, entry);
    entry.pids.push(proc.pid);
    if (!where.extension) entry.ownProcess = true;
  }

  const ppidOf = new Map(processes.map((p) => [p.pid, p.ppid]));
  const apps: AppInfo[] = [];
  const icons = new Map<string, AppIconSource>();
  for (const [id, { bundle, info, pids, ownProcess }] of found) {
    if (!ownProcess) continue;
    apps.push({ id, name: info.name, icon: info.iconFile, pids: primaryPids(pids, ppidOf) });
    if (info.iconFile) icons.set(id, { bundle, iconPath: `${bundle}/Contents/Resources/${info.iconFile}` });
  }
  return { apps: apps.sort((a, b) => a.name.localeCompare(b.name)), icons };
}

/** The innermost regular app of the chain, else the outermost that is an app at all. */
function appOf(chain: readonly string[], lookup: (bundle: string) => BundleInfo | null) {
  let outermost: { bundle: string; info: BundleInfo } | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const info = lookup(chain[i]!);
    if (!info) continue;
    if (info.regular) return { bundle: chain[i]!, info };
    outermost = { bundle: chain[i]!, info };
  }
  return outermost;
}

interface CachedPlist {
  mtimeMs: number;
  size: number;
  info: BundleInfo | null;
}

/** Production wiring: the real filesystem, and a cache that lives as long as the server. */
export function createDarwinAppCollector(fs: BundleFs = realBundleFs) {
  /** Bundle to its Info.plist as last read. Only the bundles the last tick ran into
   *  are kept, so an app that quit is not held on to. */
  let plists = new Map<string, CachedPlist>();
  let icons = new Map<string, AppIconSource>();

  const read = (bundle: string, cached: CachedPlist | undefined): CachedPlist | null => {
    const path = `${bundle}/Contents/Info.plist`;
    const st = fs.stat(path);
    if (!st) return null;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    const bytes = st.size <= MAX_INFO_PLIST_BYTES ? fs.read(path) : null;
    return { ...st, info: bytes ? bundleInfo(bundle, parsePlistBytes(bytes), fs) : null };
  };

  return {
    collect(processes: readonly AppProcess[]): AppInfo[] {
      const next = new Map<string, CachedPlist>();
      /** Chrome is forty processes and one Info.plist: stat it once per tick. */
      const seen = new Map<string, BundleInfo | null>();
      const result = collectDarwinApps(processes, (bundle) => {
        if (seen.has(bundle)) return seen.get(bundle)!;
        const plist = read(bundle, plists.get(bundle));
        if (plist) next.set(bundle, plist);
        seen.set(bundle, plist?.info ?? null);
        return plist?.info ?? null;
      });
      plists = next;
      icons = result.icons;
      return result.apps;
    },
    /** The icon of an app the last tick listed. Nothing else can be asked for. */
    iconSource(appId: string): AppIconSource | null {
      return icons.get(appId) ?? null;
    },
  };
}

export type DarwinAppCollector = ReturnType<typeof createDarwinAppCollector>;

let shared: DarwinAppCollector | null = null;

/** The one collector the tick and the icon route share, so the route can serve the
 *  icon of an app the tick listed and of nothing else. */
export function darwinAppCollector(): DarwinAppCollector {
  return (shared ??= createDarwinAppCollector());
}
