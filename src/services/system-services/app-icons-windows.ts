/**
 * A Windows app's icon as a PNG: the executable's own icon, extracted by
 * `System.Drawing.Icon.ExtractAssociatedIcon` in a one-shot PowerShell and kept under
 * `<ppm dir>/app-icons/` so each executable is converted once per version.
 *
 * The path reaches PowerShell through an environment variable, never through the
 * script text: an executable path is chosen by whoever installed the program, and
 * splicing it into a script would make a crafted folder name a command.
 *
 * Named after the executable and its mtime, like the macOS PNGs, so an update gets a
 * new file and the old one is removed as it lands; concurrent requests for one icon
 * share a single extraction.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const EXTRACT_TIMEOUT_MS = 15_000;

const EXTRACT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:PPM_ICON_SRC)",
  "$bmp = $icon.ToBitmap()",
  "$bmp.Save($env:PPM_ICON_OUT, [System.Drawing.Imaging.ImageFormat]::Png)",
].join("; ");

export function exeIconPrefix(exe: string): string {
  return `${createHash("sha1").update(exe.toLowerCase()).digest("hex").slice(0, 16)}-`;
}

function mtimeOf(path: string): number | null {
  try {
    const s = statSync(path);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}

export type IconExtractor = (exe: string, out: string) => Promise<boolean>;

/** The production extractor: one hidden PowerShell per icon, bounded by a timeout. */
export const powershellExtractor: IconExtractor = async (exe, out) => {
  try {
    const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", EXTRACT_SCRIPT], {
      env: { ...process.env, PPM_ICON_SRC: exe, PPM_ICON_OUT: out },
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    const timer = setTimeout(() => proc.kill(), EXTRACT_TIMEOUT_MS);
    const code = await proc.exited.finally(() => clearTimeout(timer));
    return code === 0;
  } catch {
    // No PowerShell at all: no icon, and the letter tile the page falls back to.
    return false;
  }
};

export function createWindowsIconConverter(dir: string, extract: IconExtractor = powershellExtractor) {
  const pending = new Map<string, Promise<string | null>>();
  /** Executables with no extractable icon. Retrying cannot help until the file changes,
   *  which changes the target name too. */
  const unreadable = new Set<string>();
  let temps = 0;

  const convert = async (exe: string, target: string): Promise<string | null> => {
    const prefix = exeIconPrefix(exe);
    const temp = join(dir, `${prefix}tmp-${process.pid}-${++temps}.png`);
    try {
      mkdirSync(dir, { recursive: true });
      if (!(await extract(exe, temp)) || mtimeOf(temp) === null) {
        rmSync(temp, { force: true });
        unreadable.add(target);
        return null;
      }
      renameSync(temp, target);
      for (const name of readdirSync(dir)) {
        if (name.startsWith(prefix) && join(dir, name) !== target) rmSync(join(dir, name), { force: true });
      }
      return target;
    } catch {
      return null;
    }
  };

  return {
    async png(exe: string): Promise<string | null> {
      const mtime = mtimeOf(exe);
      if (mtime === null) return null;
      const target = join(dir, `${exeIconPrefix(exe)}${Math.trunc(mtime)}.png`);
      if (mtimeOf(target) !== null) return target;
      if (unreadable.has(target)) return null;
      let conversion = pending.get(target);
      if (!conversion) {
        conversion = convert(exe, target).finally(() => pending.delete(target));
        pending.set(target, conversion);
      }
      return conversion;
    },
  };
}

export type WindowsIconConverter = ReturnType<typeof createWindowsIconConverter>;
