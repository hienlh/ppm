/** Resolved known-folder locations per OS — not the naive `~/Desktop` guess.
 *  Windows asks `[Environment]::GetFolderPath` (handles OneDrive-redirected
 *  folders) plus the registry for Downloads (no `SHGetKnownFolderPath` shim
 *  in `[Environment]`). macOS prefers the iCloud "Desktop & Documents" sync
 *  location when present (Finder silently moves the real content there).
 *  Linux asks `xdg-user-dir` (merges locale + `/etc/xdg` defaults), falling
 *  back to a tolerant regex parse of `user-dirs.dirs`. */
import * as fsp from "node:fs/promises";
import type { KnownFolder, KnownFolderKey } from "../../types/system.ts";
import { defaultRunner, type Runner } from "./spawn-runner.ts";

export interface KnownFolderDeps {
  run: Runner;
  pathExists: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string>;
}

const defaultDeps: KnownFolderDeps = {
  run: defaultRunner,
  pathExists: async (p) => {
    try {
      return (await fsp.stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  readFile: (p) => fsp.readFile(p, "utf-8"),
};

// ── Windows ──────────────────────────────────────────────────────────────

const WIN_NAMES: Record<string, string> = {
  desktop: "Desktop",
  documents: "Documents",
  pictures: "Pictures",
  music: "Music",
  videos: "Videos",
  downloads: "Downloads",
};

const WIN_SCRIPT = `
$r = [ordered]@{}
$r.desktop = [Environment]::GetFolderPath('Desktop')
$r.documents = [Environment]::GetFolderPath('MyDocuments')
$r.pictures = [Environment]::GetFolderPath('MyPictures')
$r.music = [Environment]::GetFolderPath('MyMusic')
$r.videos = [Environment]::GetFolderPath('MyVideos')
$reg = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -ErrorAction SilentlyContinue
$dl = $reg.'{374DE290-123F-4565-9164-39C4925E467B}'
if ($dl) { $r.downloads = [Environment]::ExpandEnvironmentVariables($dl) }
$r | ConvertTo-Json -Compress
`.trim();

async function getWindowsKnownFolders(deps: KnownFolderDeps, warnings: string[]): Promise<KnownFolder[]> {
  try {
    const res = await deps.run(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_SCRIPT],
      5000,
    );
    if (res.timedOut || res.code !== 0) {
      warnings.push(`knownFolders: PowerShell ${res.timedOut ? "timed out" : `exited ${res.code}`}`);
      return [];
    }
    const parsed = JSON.parse(res.stdout.trim() || "{}") as Record<string, string | undefined>;
    const folders: KnownFolder[] = [];
    for (const key of Object.keys(WIN_NAMES)) {
      const path = parsed[key];
      if (path) folders.push({ key: key as KnownFolderKey, name: WIN_NAMES[key]!, path });
    }
    return folders;
  } catch (e) {
    warnings.push(`knownFolders: PowerShell failed (${(e as Error)?.message ?? e})`);
    return [];
  }
}

// ── macOS ────────────────────────────────────────────────────────────────

const DARWIN_FOLDERS: { key: KnownFolderKey; name: string; dir: string; cloudSynced: boolean }[] = [
  { key: "desktop", name: "Desktop", dir: "Desktop", cloudSynced: true },
  { key: "documents", name: "Documents", dir: "Documents", cloudSynced: true },
  { key: "downloads", name: "Downloads", dir: "Downloads", cloudSynced: false },
  { key: "pictures", name: "Pictures", dir: "Pictures", cloudSynced: false },
  { key: "music", name: "Music", dir: "Music", cloudSynced: false },
  { key: "videos", name: "Movies", dir: "Movies", cloudSynced: false },
];

async function getDarwinKnownFolders(deps: KnownFolderDeps, homedir: string): Promise<KnownFolder[]> {
  const cloudRoot = `${homedir}/Library/Mobile Documents/com~apple~CloudDocs`;
  const cloudExists = await deps.pathExists(cloudRoot);
  const folders: KnownFolder[] = [];
  for (const entry of DARWIN_FOLDERS) {
    let path = `${homedir}/${entry.dir}`;
    if (entry.cloudSynced && cloudExists) {
      const cloudPath = `${cloudRoot}/${entry.dir}`;
      if (await deps.pathExists(cloudPath)) path = cloudPath;
    }
    folders.push({ key: entry.key, name: entry.name, path });
  }
  if (cloudExists) folders.push({ key: "icloud", name: "iCloud Drive", path: cloudRoot });
  return folders;
}

// ── Linux ────────────────────────────────────────────────────────────────

const LINUX_FOLDERS: { key: KnownFolderKey; name: string; xdg: string }[] = [
  { key: "desktop", name: "Desktop", xdg: "DESKTOP" },
  { key: "documents", name: "Documents", xdg: "DOCUMENTS" },
  { key: "downloads", name: "Downloads", xdg: "DOWNLOAD" },
  { key: "pictures", name: "Pictures", xdg: "PICTURES" },
  { key: "music", name: "Music", xdg: "MUSIC" },
  { key: "videos", name: "Videos", xdg: "VIDEOS" },
];

async function readUserDirsFallback(
  deps: KnownFolderDeps,
  homedir: string,
  warnings: string[],
): Promise<Record<string, string>> {
  try {
    const raw = await deps.readFile(`${homedir}/.config/user-dirs.dirs`);
    const map: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const m = line.match(/^XDG_(\w+)_DIR="(.+)"$/);
      if (!m) continue;
      map[m[1]!] = m[2]!.replace("$HOME", homedir);
    }
    return map;
  } catch (e) {
    warnings.push(`knownFolders: user-dirs.dirs read failed (${(e as Error)?.message ?? e})`);
    return {};
  }
}

async function getLinuxKnownFolders(
  deps: KnownFolderDeps,
  homedir: string,
  warnings: string[],
): Promise<KnownFolder[]> {
  const folders: KnownFolder[] = [];
  let fallback: Record<string, string> | null = null;
  for (const entry of LINUX_FOLDERS) {
    let path: string | undefined;
    try {
      const res = await deps.run(["xdg-user-dir", entry.xdg], 3000);
      if (!res.timedOut && res.code === 0) {
        const out = res.stdout.trim();
        if (out && out !== homedir) path = out;
      }
    } catch {
      // spawn itself threw (e.g. xdg-user-dir not installed) — fall through to file parse
    }
    if (!path) {
      fallback ??= await readUserDirsFallback(deps, homedir, warnings);
      path = fallback[entry.xdg];
    }
    if (path) folders.push({ key: entry.key, name: entry.name, path });
  }
  return folders;
}

/** Resolve known folders for `platform`, appending any failure to the shared `warnings` array (never throws). */
export async function getKnownFolders(
  platform: NodeJS.Platform,
  homedir: string,
  warnings: string[],
  overrides: Partial<KnownFolderDeps> = {},
): Promise<KnownFolder[]> {
  const deps: KnownFolderDeps = { ...defaultDeps, ...overrides };
  try {
    if (platform === "win32") return await getWindowsKnownFolders(deps, warnings);
    if (platform === "darwin") return await getDarwinKnownFolders(deps, homedir);
    if (platform === "linux") return await getLinuxKnownFolders(deps, homedir, warnings);
    warnings.push(`knownFolders: unsupported platform "${platform}"`);
    return [];
  } catch (e) {
    warnings.push(`knownFolders: unexpected failure (${(e as Error)?.message ?? e})`);
    return [];
  }
}
