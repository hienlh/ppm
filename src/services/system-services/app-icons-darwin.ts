/**
 * A macOS app's icon as an image the browser can draw: the bundle's `.icns`
 * converted by `sips` to a 64 px PNG (20 ms and about 5 KB for Chrome's), kept
 * under `<ppm dir>/app-icons/` so each icon is converted once.
 *
 * A PNG is named after its bundle and the icon file's mtime. An update that
 * replaces the icon therefore gets a new PNG, and the old one is removed as the
 * new one lands. The Apps page asks for every icon at once when it opens, so two
 * requests for one icon share a conversion instead of racing on the file.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultRunner, type Runner } from "../host-info/spawn-runner.ts";

export const ICON_PX = 64;
const SIPS_TIMEOUT_MS = 10_000;

/** Every file of one bundle starts with this, which is how its old PNGs are found. */
export function bundleIconPrefix(bundle: string): string {
  return `${createHash("sha1").update(bundle).digest("hex").slice(0, 16)}-`;
}

export function iconCacheName(bundle: string, iconMtimeMs: number): string {
  return `${bundleIconPrefix(bundle)}${Math.trunc(iconMtimeMs)}.png`;
}

function mtimeOf(path: string): number | null {
  try {
    const s = statSync(path);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}

export function createDarwinIconConverter(dir: string, run: Runner = defaultRunner) {
  const pending = new Map<string, Promise<string | null>>();
  /** Icons sips could not read. Converting one again on every request cannot help;
   *  an update to the app changes its mtime, and so the file asked for. */
  const unreadable = new Set<string>();
  let temps = 0;

  const convert = async (bundle: string, iconPath: string, target: string): Promise<string | null> => {
    const prefix = bundleIconPrefix(bundle);
    // Named like the bundle's PNGs, so one left behind by a crash is cleaned up
    // with them the next time this icon is converted.
    const temp = join(dir, `${prefix}tmp-${process.pid}-${++temps}.png`);
    try {
      mkdirSync(dir, { recursive: true });
      const r = await run(["sips", "-s", "format", "png", "-Z", String(ICON_PX), iconPath, "--out", temp], SIPS_TIMEOUT_MS);
      if (r.code !== 0 || mtimeOf(temp) === null) {
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
      // The cache directory could not be written: no icon this time, and the
      // letter tile the page falls back to.
      return null;
    }
  };

  return {
    /** The PNG of one bundle's icon file, converting it on first use; null when
     *  the icon cannot be read. */
    async png(bundle: string, iconPath: string): Promise<string | null> {
      const mtime = mtimeOf(iconPath);
      if (mtime === null) return null;
      const target = join(dir, iconCacheName(bundle, mtime));
      if (mtimeOf(target) !== null) return target;
      if (unreadable.has(target)) return null;
      let conversion = pending.get(target);
      if (!conversion) {
        conversion = convert(bundle, iconPath, target).finally(() => pending.delete(target));
        pending.set(target, conversion);
      }
      return conversion;
    },
  };
}

export type DarwinIconConverter = ReturnType<typeof createDarwinIconConverter>;
