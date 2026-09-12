/**
 * The Apps page: which desktop applications are running, and which pids are
 * theirs - Mission Center's app list.
 *
 * Matching is primary-source rather than heuristic. A systemd graphical session
 * puts every launched app in its own app scope whose unit name states the desktop
 * entry id, so a pid names its app outright (see app-cgroup-linux.ts). The exec
 * fallback below exists only for a session that is not systemd-managed, where
 * there is no scope to read.
 *
 * Injectable filesystem throughout, so the whole thing is fixture-tested.
 */
import type { AppInfo } from "../../types/system-metrics.ts";
import type { LinuxFs } from "../system-metrics/linux-fs.ts";
import { realLinuxFs } from "../system-metrics/linux-fs.ts";
import { appIdFromCgroup } from "./app-cgroup-linux.ts";
import { execBinary, parseDesktopEntry, type DesktopEntry } from "./desktop-entry.ts";

const DESKTOP_SUFFIX = ".desktop";

/**
 * The XDG search path, most specific first. Precedence is what decides which copy
 * of a duplicated id wins: a user's own entry must beat the system one, which is
 * how an override in the home directory works at all.
 */
export function desktopDirs(env: Record<string, string | undefined>, home: string): string[] {
  const dataHome = env.XDG_DATA_HOME || `${home}/.local/share`;
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const base of [dataHome, ...dataDirs]) {
    const dir = `${base}/applications`;
    if (!seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  }
  return dirs;
}

/** id to entry. The FIRST directory to define an id wins, per XDG precedence. */
export function loadDesktopEntries(dirs: readonly string[], fs: LinuxFs): Map<string, DesktopEntry> {
  const entries = new Map<string, DesktopEntry>();
  for (const dir of dirs) {
    for (const file of fs.list(dir) ?? []) {
      if (!file.endsWith(DESKTOP_SUFFIX)) continue;
      const id = file.slice(0, -DESKTOP_SUFFIX.length);
      if (entries.has(id)) continue;
      const text = fs.read(`${dir}/${file}`);
      const entry = text === null ? null : parseDesktopEntry(id, text);
      if (entry) entries.set(id, entry);
    }
  }
  return entries;
}

/** What the tick calls once per full snapshot. */
export type AppCollector = (processes: readonly AppProcess[]) => AppInfo[];

/** A process as this module needs it - the subset the tick already has in hand. */
export interface AppProcess {
  pid: number;
  ppid: number;
  name: string;
}

export interface CollectAppsInput {
  processes: readonly AppProcess[];
  entries: Map<string, DesktopEntry>;
  /** `/proc/<pid>/cgroup` for one pid, or null when it is gone. */
  readCgroup: (pid: number) => string | null;
}

/**
 * Apps with at least one live process, name-sorted.
 *
 * A NoDisplay entry is skipped: its author asked for it not to appear in menus,
 * and including them would list every url-handler and console helper shipped
 * beside a real app.
 */
export function collectApps(input: CollectAppsInput): AppInfo[] {
  const { processes, entries, readCgroup } = input;
  const byBinary = execBinaryIndex(entries);
  const pidsByApp = new Map<string, number[]>();

  for (const proc of processes) {
    const id = matchApp(proc, entries, byBinary, readCgroup);
    if (!id) continue;
    const list = pidsByApp.get(id);
    if (list) list.push(proc.pid);
    else pidsByApp.set(id, [proc.pid]);
  }

  const ppidOf = new Map(processes.map((p) => [p.pid, p.ppid]));
  const apps: AppInfo[] = [];
  for (const [id, pids] of pidsByApp) {
    const entry = entries.get(id);
    if (!entry) continue;
    apps.push({ id, name: entry.name, icon: entry.icon, pids: primaryPids(pids, ppidOf) });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The pids that stand for the app: those whose parent is not also one of its own.
 * Each is the root of a subtree, which is what an app row's figures sum over -
 * counting every member would count a helper's CPU once per level of nesting.
 */
export function primaryPids(pids: readonly number[], ppidOf: Map<number, number>): number[] {
  const own = new Set(pids);
  return pids.filter((pid) => !own.has(ppidOf.get(pid) ?? -1)).sort((a, b) => a - b);
}

/**
 * Exec binary to id, for the fallback match. Ambiguous binaries are dropped
 * entirely rather than resolved arbitrarily: two entries launching `sh` must not
 * make every shell on the machine look like one of them.
 */
export function execBinaryIndex(entries: Map<string, DesktopEntry>): Map<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.noDisplay) continue;
    const binary = execBinary(entry.exec);
    if (!binary) continue;
    if (index.has(binary)) ambiguous.add(binary);
    else index.set(binary, entry.id);
  }
  for (const binary of ambiguous) index.delete(binary);
  return index;
}

function matchApp(
  proc: AppProcess,
  entries: Map<string, DesktopEntry>,
  byBinary: Map<string, string>,
  readCgroup: (pid: number) => string | null,
): string | null {
  const cgroup = readCgroup(proc.pid);
  const scoped = cgroup ? appIdFromCgroup(cgroup) : null;
  if (scoped) {
    const entry = entries.get(scoped);
    // A scope naming an id no entry defines is still not an app PPM can show:
    // it has no name and no icon to draw.
    if (entry && !entry.noDisplay) return scoped;
    return null;
  }
  // Not in an app scope. Only an exact executable-name match counts, so a shell
  // or an editor started by something else is not attributed to an app.
  const id = byBinary.get(proc.name);
  return id && !entries.get(id)?.noDisplay ? id : null;
}

/** Production wiring: the real XDG dirs and the real /proc. */
export function createLinuxAppCollector(fs: LinuxFs = realLinuxFs) {
  const dirs = desktopDirs(process.env, process.env.HOME ?? "/root");
  let entries: Map<string, DesktopEntry> | null = null;
  return {
    /** Desktop entries change only when a package is installed; read once. */
    entries(): Map<string, DesktopEntry> {
      entries ??= loadDesktopEntries(dirs, fs);
      return entries;
    },
    collect(processes: readonly AppProcess[]): AppInfo[] {
      return collectApps({
        processes,
        entries: this.entries(),
        readCgroup: (pid) => fs.read(`/proc/${pid}/cgroup`),
      });
    },
  };
}

export type LinuxAppCollector = ReturnType<typeof createLinuxAppCollector>;
