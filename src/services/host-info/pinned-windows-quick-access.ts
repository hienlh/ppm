/** Windows Quick Access pinned folders via the Shell COM `Namespace`
 *  (`shell:::{679f85cb-...}`), verified live: ~150ms enumeration, and
 *  `System.Home.IsPinned` reliably separates pinned entries from "frequent"
 *  ones. Shell COM reports `.zip`/`.rar` archives as `IsFolder=true`, so
 *  every candidate is re-checked with a real directory stat before it ships. */
import * as fsp from "node:fs/promises";
import type { PinnedFolder } from "../../types/system.ts";
import { defaultRunner, type Runner } from "./spawn-runner.ts";

export interface QuickAccessDeps {
  run: Runner;
  isDirectory: (path: string) => Promise<boolean>;
}

const defaultDeps: QuickAccessDeps = {
  run: defaultRunner,
  isDirectory: async (p) => {
    try {
      return (await fsp.stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
};

// `@($result)` forces an array even for 0/1 items — ConvertTo-Json unwraps a
// single-element pipeline input into a bare object otherwise.
const QUICK_ACCESS_SCRIPT = `
$items = (New-Object -ComObject Shell.Application).Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}').Items()
$result = foreach ($i in $items) {
  if ($i.IsFolder) {
    [PSCustomObject]@{ Name = $i.Name; Path = $i.Path; Pinned = $i.ExtendedProperty('System.Home.IsPinned') }
  }
}
$arr = @($result)
$json = $arr | ConvertTo-Json -Compress
if ($arr.Count -le 1) { $json = '[' + $json + ']' }
Write-Output $json
`.trim();

interface RawItem {
  Name?: string;
  Path?: string;
  Pinned?: boolean | string | null;
}

function isPinned(v: RawItem["Pinned"]): boolean {
  return v === true || v === "True" || v === "true";
}

/** Read Quick Access pinned folders, appending any failure to the shared `warnings` array (never throws). */
export async function getWindowsQuickAccessPinned(
  warnings: string[],
  overrides: Partial<QuickAccessDeps> = {},
): Promise<PinnedFolder[]> {
  const deps: QuickAccessDeps = { ...defaultDeps, ...overrides };
  try {
    const res = await deps.run(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", QUICK_ACCESS_SCRIPT],
      5000,
    );
    if (res.timedOut || res.code !== 0) {
      warnings.push(`pinned: Quick Access ${res.timedOut ? "timed out" : `exited ${res.code}`}`);
      return [];
    }

    let raw: RawItem[];
    try {
      const parsed = JSON.parse(res.stdout.trim() || "[]");
      raw = (Array.isArray(parsed) ? parsed : [parsed]).filter((x): x is RawItem => x != null);
    } catch (e) {
      warnings.push(`pinned: Quick Access JSON parse failed (${(e as Error)?.message ?? e})`);
      return [];
    }

    const pinned: PinnedFolder[] = [];
    for (const item of raw) {
      if (!item.Name || !item.Path || !isPinned(item.Pinned)) continue;
      if (!(await deps.isDirectory(item.Path))) continue; // drops archive-as-folder (.zip/.rar) and stale entries
      pinned.push({ name: item.Name, path: item.Path, source: "quick-access" });
    }
    return pinned;
  } catch (e) {
    warnings.push(`pinned: Quick Access failed (${(e as Error)?.message ?? e})`);
    return [];
  }
}
