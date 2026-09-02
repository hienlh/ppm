/** Drive/volume enumeration per OS. Windows probes A:-Z: async (never
 *  `existsSync` — a disconnected mapped drive blocks the event loop) and
 *  merges `Get-CimInstance Win32_LogicalDisk` for kind/label only, so a dead
 *  network share never empties the whole list. macOS reads `/Volumes` minus
 *  the boot-volume symlink-to-root. Linux prefers `findmnt`, falls back to
 *  `/proc/mounts`, and always ships root `/`. */
import * as fsp from "node:fs/promises";
import type { Drive, DriveKind } from "../../types/system.ts";
import { defaultRunner, type Runner } from "./spawn-runner.ts";

export interface DriveDeps {
  run: Runner;
  stat: (path: string) => Promise<unknown>;
  readdir: (path: string) => Promise<string[]>;
  lstat: (path: string) => Promise<{ isSymbolicLink: () => boolean }>;
  readlink: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<string>;
}

const defaultDeps: DriveDeps = {
  run: defaultRunner,
  stat: (p) => fsp.stat(p),
  readdir: (p) => fsp.readdir(p),
  lstat: (p) => fsp.lstat(p),
  readlink: (p) => fsp.readlink(p),
  readFile: (p) => fsp.readFile(p, "utf-8"),
};

const WIN_LETTER_TIMEOUT_MS = 1500;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const CIM_SCRIPT =
  "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName | ConvertTo-Json -Compress";

interface CimRow {
  DeviceID: string;
  DriveType: number;
  VolumeName?: string;
}

function driveKindFromCimType(t: number): DriveKind {
  if (t === 2) return "removable";
  if (t === 3) return "fixed";
  if (t === 4) return "network";
  return "unknown";
}

async function probeWindowsLetters(deps: DriveDeps): Promise<string[]> {
  const checks = LETTERS.map(async (letter) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), WIN_LETTER_TIMEOUT_MS);
    });
    try {
      await Promise.race([deps.stat(`${letter}:\\`), timeout]);
      return letter;
    } catch {
      return null; // no drive at this letter, or the mapped drive is unreachable (timed out)
    } finally {
      clearTimeout(timer); // avoid leaving up to 26 pending timers alive per scan
    }
  });
  return (await Promise.all(checks)).filter((l): l is string => l !== null);
}

async function getWindowsDrives(deps: DriveDeps, warnings: string[]): Promise<Drive[]> {
  const letters = await probeWindowsLetters(deps);
  const drives: Drive[] = letters.map((l) => ({ name: `${l}:`, path: `${l}:\\`, kind: "unknown" }));

  let cimRows: CimRow[] = [];
  try {
    const res = await deps.run(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", CIM_SCRIPT],
      5000,
    );
    if (res.timedOut || res.code !== 0) {
      warnings.push(`drives: Get-CimInstance Win32_LogicalDisk ${res.timedOut ? "timed out" : `exited ${res.code}`}, drive kind unknown`);
    } else {
      const parsed = JSON.parse(res.stdout.trim() || "[]");
      cimRows = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch (e) {
    warnings.push(`drives: Get-CimInstance Win32_LogicalDisk failed (${(e as Error)?.message ?? e}), drive kind unknown`);
  }

  const cimByLetter = new Map(cimRows.map((r) => [r.DeviceID, r]));
  for (const drive of drives) {
    const row = cimByLetter.get(drive.name);
    if (!row) continue;
    drive.kind = driveKindFromCimType(row.DriveType);
    if (row.VolumeName) drive.label = row.VolumeName;
  }
  return drives;
}

async function getDarwinDrives(deps: DriveDeps, warnings: string[]): Promise<Drive[]> {
  let entries: string[] = [];
  try {
    entries = await deps.readdir("/Volumes");
  } catch (e) {
    warnings.push(`drives: readdir(/Volumes) failed (${(e as Error)?.message ?? e})`);
    return [];
  }

  const drives: Drive[] = [];
  for (const name of entries) {
    const path = `/Volumes/${name}`;
    try {
      const st = await deps.lstat(path);
      if (st.isSymbolicLink()) {
        const target = await deps.readlink(path);
        if (target === "/" || target === "") continue; // boot volume alias, not a distinct browsable drive
      }
      drives.push({ name, path, kind: "unknown" });
    } catch {
      // Vanished between readdir and lstat (unmounted mid-scan) — skip, not fatal.
    }
  }
  return drives;
}

interface FindmntEntry {
  target: string;
  source: string;
}

const LINUX_MOUNT_PREFIXES = ["/media/", "/run/media/", "/mnt/"];

async function getLinuxDrives(deps: DriveDeps, warnings: string[]): Promise<Drive[]> {
  const drives: Drive[] = [{ name: "/", path: "/", kind: "fixed" }];
  let entries: FindmntEntry[] = [];

  try {
    const res = await deps.run(["findmnt", "-J", "--real", "-o", "TARGET,SOURCE,FSTYPE"], 5000);
    if (res.timedOut || res.code !== 0) throw new Error(res.timedOut ? "timed out" : `exited ${res.code}`);
    const parsed = JSON.parse(res.stdout);
    entries = (parsed?.filesystems ?? []).map((f: any) => ({ target: String(f.target ?? ""), source: String(f.source ?? "") }));
  } catch (e) {
    warnings.push(`drives: findmnt failed (${(e as Error)?.message ?? e}), falling back to /proc/mounts`);
    try {
      const raw = await deps.readFile("/proc/mounts");
      entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parts = line.split(" ");
          return { source: parts[0] ?? "", target: parts[1] ?? "" };
        });
    } catch (e2) {
      warnings.push(`drives: /proc/mounts read failed (${(e2 as Error)?.message ?? e2})`);
      return drives;
    }
  }

  for (const entry of entries) {
    if (!entry.target || entry.target === "/") continue;
    if (!LINUX_MOUNT_PREFIXES.some((p) => entry.target.startsWith(p))) continue;
    const name = entry.target.split("/").filter(Boolean).pop() ?? entry.target;
    drives.push({ name, path: entry.target, kind: "unknown" });
  }
  return drives;
}

/** Enumerate drives for `platform`, appending any failure to the shared `warnings` array (never throws). */
export async function getDrives(
  platform: NodeJS.Platform,
  warnings: string[],
  overrides: Partial<DriveDeps> = {},
): Promise<Drive[]> {
  const deps: DriveDeps = { ...defaultDeps, ...overrides };
  try {
    if (platform === "win32") return await getWindowsDrives(deps, warnings);
    if (platform === "darwin") return await getDarwinDrives(deps, warnings);
    if (platform === "linux") return await getLinuxDrives(deps, warnings);
    warnings.push(`drives: unsupported platform "${platform}"`);
    return [];
  } catch (e) {
    warnings.push(`drives: unexpected failure (${(e as Error)?.message ?? e})`);
    return [];
  }
}
