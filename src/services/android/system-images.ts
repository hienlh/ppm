/**
 * Which Android system images this host already has.
 *
 * Read from **disk**, not from `sdkmanager --list_installed`. Three reasons, all measured:
 *
 *  - `sdkmanager` takes seconds ("Loading local repository…") and prints a progress bar into
 *    stdout that any parser has to strip; a tab that lists images on open would stall on it.
 *  - Every installed image ships a `source.properties` carrying exactly what is needed — API
 *    level, ABI, tag, a display description — so the subprocess buys nothing.
 *  - A host with the images but no `cmdline-tools` (they are a separate SDK package) can still
 *    create an AVD, and going through `sdkmanager` would report "no images" there.
 *
 * Installing a *new* image is deliberately not here: the plan is explicit that PPM must not
 * accept an SDK licence or start a multi-gigabyte download on its own.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SystemImage {
  /** The sdkmanager package path, e.g. `system-images;android-35;google_apis_playstore;x86_64`. */
  id: string;
  apiLevel: number | null;
  abi: string;
  /** `google_apis_playstore`, `default`, `android-automotive`… */
  tag: string;
  /** What Google calls it, e.g. "Google APIs PlayStore,Tablet". */
  tagDisplay: string;
  description: string;
  /** `image.sysdir.1` wants this exact relative form, trailing slash included. */
  sysdir: string;
  /** True when the image carries Play Store — such an AVD cannot be rooted. */
  playStore: boolean;
  bytes: number;
}

function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** Recursive size of an image directory, so the UI can say what a delete would free. */
function directoryBytes(dir: string, depth = 0): number {
  if (depth > 4) return 0;
  let total = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directoryBytes(full, depth + 1);
      else if (entry.isFile()) total += statSync(full).size;
    } catch { /* it went away mid-walk */ }
  }
  return total;
}

/**
 * The tree is `system-images/<api>/<tag>/<abi>/`, and only a directory with a
 * `source.properties` counts — a half-deleted package leaves the directories behind.
 */
export function listSystemImages(sdkRoot: string | null): SystemImage[] {
  if (!sdkRoot) return [];
  const root = join(sdkRoot, "system-images");
  if (!existsSync(root)) return [];

  const images: SystemImage[] = [];
  for (const api of safeList(root)) {
    for (const tagDir of safeList(join(root, api))) {
      for (const abi of safeList(join(root, api, tagDir))) {
        const dir = join(root, api, tagDir, abi);
        const propsPath = join(dir, "source.properties");
        if (!existsSync(propsPath)) continue;

        let props: Record<string, string>;
        try { props = parseProperties(readFileSync(propsPath, "utf8")); } catch { continue; }

        const apiLevel = Number(props["AndroidVersion.ApiLevel"]);
        // `SystemImage.TagId` can be a comma list (`google_apis_playstore,tablet`); the first is
        // the one the package path uses, and the rest are extra traits.
        const tag = (props["SystemImage.TagId"] ?? tagDir).split(",")[0]!.trim();
        images.push({
          id: `system-images;${api};${tagDir};${abi}`,
          apiLevel: Number.isFinite(apiLevel) ? apiLevel : null,
          abi: props["SystemImage.Abi"] ?? abi,
          tag,
          tagDisplay: props["SystemImage.TagDisplay"] ?? tag,
          description: props["Pkg.Desc"] ?? "",
          sysdir: `system-images/${api}/${tagDir}/${abi}/`,
          playStore: tagDir.includes("playstore") || tag.includes("playstore"),
          bytes: directoryBytes(dir),
        });
      }
    }
  }
  // Newest API first: that is almost always the one being reached for.
  return images.sort((a, b) => (b.apiLevel ?? 0) - (a.apiLevel ?? 0) || a.id.localeCompare(b.id));
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Whether an image can run on this host without full-system emulation.
 *
 * An arm64 image on an x86_64 host boots, and then takes minutes per screen — which reads as a
 * broken emulator rather than the wrong ABI, so the picker says so before the AVD exists.
 */
export function abiMatchesHost(abi: string, hostArch = process.arch): boolean {
  if (hostArch === "x64") return abi === "x86_64" || abi === "x86";
  if (hostArch === "arm64") return abi === "arm64-v8a" || abi === "armeabi-v7a";
  return true;
}
