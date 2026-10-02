/**
 * The Apps page on Windows: which applications are running, and which pids are theirs.
 *
 * An app is what Task Manager's "Apps" group shows: a program with a window a person
 * would call open (see `appWindowOwners` for the rule). Its identity is its executable
 * path, so every process launched from that same file folds into it — Chrome is one
 * window-owning `chrome.exe` and forty more without a window — and the subtree under
 * each of those comes along client-side (`buildAppRows`), which is how a WebView2 or a
 * crash handler with a different executable is still counted against its app.
 *
 * Two rules from real machines:
 *
 * - Store apps draw their window from `ApplicationFrameHost.exe`, one process for all of
 *   them. Grouped by executable they would be a single app called "Application Frame
 *   Host", so each of its windows is an app of its own, named by its title.
 * - Only processes sharing a window owner's executable NAME are asked for their path.
 *   Opening a process to read its path is cheap but not free, and the alternative is
 *   asking it of all four hundred processes on every tick.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { AppInfo } from "../../types/system-metrics.ts";
import { primaryPids, type AppProcess } from "./apps-linux.ts";
import { appWindowOwners, fileDescription, processImagePath } from "./apps-windows-native.ts";

const FRAME_HOST = "applicationframehost.exe";

export interface WindowsAppSources {
  /** pid → title of a window that makes it an app. */
  windowOwners: () => Map<number, string>;
  imagePath: (pid: number) => string | null;
  /** The executable's own name for itself, or null. */
  describe: (exePath: string) => string | null;
}

export interface WindowsAppList {
  apps: AppInfo[];
  /** id → executable, for the icon route. Only listed apps are in it. */
  icons: Map<string, string>;
}

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);

/** Stable, URL-safe and free of path characters, which the icon route refuses. */
export function windowsAppId(key: string): string {
  return `win-${createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

export function collectWindowsApps(processes: readonly AppProcess[], sources: WindowsAppSources): WindowsAppList {
  const owners = sources.windowOwners();
  const live = new Set(processes.map((p) => p.pid));
  const found = new Map<string, { name: string; exe: string; pids: number[] }>();
  /** Executable name (lower-cased) → keys of the apps launched from a file of that name. */
  const byName = new Map<string, Set<string>>();
  const pathOf = new Map<number, string | null>();
  const imagePath = (pid: number) => {
    if (!pathOf.has(pid)) pathOf.set(pid, sources.imagePath(pid));
    return pathOf.get(pid)!;
  };

  for (const [pid, title] of owners) {
    if (!live.has(pid)) continue;
    const exe = imagePath(pid);
    if (!exe) continue;
    const exeName = baseName(exe).toLowerCase();
    const frameHost = exeName === FRAME_HOST;
    const key = frameHost ? `${exe.toLowerCase()}\0${title}` : exe.toLowerCase();
    const entry = found.get(key);
    if (entry) {
      entry.pids.push(pid);
      continue;
    }
    const name = frameHost ? title : sources.describe(exe) ?? baseName(exe).replace(/\.exe$/i, "");
    found.set(key, { name, exe, pids: [pid] });
    // A frame host's other processes are other apps' windows, never this one's helpers.
    if (!frameHost) {
      const keys = byName.get(exeName) ?? new Set<string>();
      keys.add(key);
      byName.set(exeName, keys);
    }
  }

  for (const proc of processes) {
    if (owners.has(proc.pid)) continue;
    const keys = byName.get(proc.name.toLowerCase());
    if (!keys) continue;
    const key = imagePath(proc.pid)?.toLowerCase();
    if (key && keys.has(key)) found.get(key)!.pids.push(proc.pid);
  }

  const ppidOf = new Map(processes.map((p) => [p.pid, p.ppid]));
  const apps: AppInfo[] = [];
  const icons = new Map<string, string>();
  for (const [key, { name, exe, pids }] of found) {
    const id = windowsAppId(key);
    apps.push({ id, name, icon: baseName(exe), pids: primaryPids(pids, ppidOf) });
    icons.set(id, exe);
  }
  return { apps: apps.sort((a, b) => a.name.localeCompare(b.name)), icons };
}

/** `FileDescription` is read once per executable and version: an update changes the
 *  file, and so its mtime and size. */
function cachedDescribe(read: (exe: string) => string | null) {
  let cache = new Map<string, { stamp: string; name: string | null }>();
  let seen = new Map<string, { stamp: string; name: string | null }>();
  return {
    describe(exe: string): string | null {
      let stamp = "";
      try { const s = statSync(exe); stamp = `${s.mtimeMs}:${s.size}`; } catch { /* unreadable: no stamp */ }
      const hit = seen.get(exe) ?? cache.get(exe);
      if (hit && hit.stamp === stamp) { seen.set(exe, hit); return hit.name; }
      const fresh = { stamp, name: read(exe) };
      seen.set(exe, fresh);
      return fresh.name;
    },
    /** Keep only what this tick used, so an app that quit is not held on to. */
    endTick() { cache = seen; seen = new Map(); },
  };
}

export function createWindowsAppCollector(sources: Partial<WindowsAppSources> = {}) {
  const names = cachedDescribe(sources.describe ?? fileDescription);
  let icons = new Map<string, string>();
  return {
    collect(processes: readonly AppProcess[]): AppInfo[] {
      const result = collectWindowsApps(processes, {
        windowOwners: sources.windowOwners ?? appWindowOwners,
        imagePath: sources.imagePath ?? processImagePath,
        describe: (exe) => names.describe(exe),
      });
      names.endTick();
      icons = result.icons;
      return result.apps;
    },
    /** The executable of an app the last tick listed. Nothing else can be asked for. */
    iconSource(appId: string): string | null {
      return icons.get(appId) ?? null;
    },
  };
}

export type WindowsAppCollector = ReturnType<typeof createWindowsAppCollector>;

let shared: WindowsAppCollector | null = null;

/** The one collector the tick and the icon route share, so the route serves the icon of
 *  an app the tick listed and of nothing else. */
export function windowsAppCollector(): WindowsAppCollector {
  return (shared ??= createWindowsAppCollector());
}
