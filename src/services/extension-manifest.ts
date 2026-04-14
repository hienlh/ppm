import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { ExtensionManifest } from "../types/extension.ts";

/** Parse a package.json object into an ExtensionManifest (or null if invalid) */
export function parseManifest(pkg: Record<string, unknown>): ExtensionManifest | null {
  const name = pkg.name as string | undefined;
  const version = pkg.version as string | undefined;
  const main = pkg.main as string | undefined;
  if (!name || !version || !main) return null;

  const ppmField = pkg.ppm as Record<string, unknown> | undefined;
  return {
    id: name,
    version,
    main,
    displayName: (ppmField?.displayName as string) || (pkg.displayName as string) || name,
    description: pkg.description as string | undefined,
    icon: (ppmField?.icon as string) || undefined,
    engines: pkg.engines as ExtensionManifest["engines"],
    activationEvents: pkg.activationEvents as string[] | undefined,
    contributes: pkg.contributes as ExtensionManifest["contributes"],
    ppm: ppmField as ExtensionManifest["ppm"],
    permissions: pkg.permissions as string[] | undefined,
  };
}

/** Read and parse manifest from a directory containing package.json */
export function readManifestAt(dir: string): ExtensionManifest | null {
  const pkgPath = resolve(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return parseManifest(raw);
  } catch {
    return null;
  }
}

/** Scan extensions directory (node_modules) for all valid manifests */
export async function discoverManifests(extensionsDir: string): Promise<ExtensionManifest[]> {
  const manifests: ExtensionManifest[] = [];
  if (!existsSync(extensionsDir)) return manifests;

  const entries = await readdir(extensionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name === "node_modules" || entry.name === "package.json") continue;

    // Handle scoped packages (@scope/name)
    const entryPath = resolve(extensionsDir, entry.name);
    if (entry.name.startsWith("@")) {
      const scopedEntries = await readdir(entryPath, { withFileTypes: true });
      for (const scoped of scopedEntries) {
        const manifest = readManifestAt(resolve(entryPath, scoped.name));
        if (manifest) manifests.push(manifest);
      }
    } else {
      const manifest = readManifestAt(entryPath);
      if (manifest) manifests.push(manifest);
    }
  }
  return manifests;
}

export type BundledManifest = ExtensionManifest & { _dir: string };

/** Scan packages directory for bundled extensions (ext-* dirs) */
export async function discoverBundledManifests(packagesDir: string): Promise<BundledManifest[]> {
  const manifests: BundledManifest[] = [];
  if (!existsSync(packagesDir)) return manifests;

  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("ext-")) continue;
    const dir = resolve(packagesDir, entry.name);
    const manifest = readManifestAt(dir);
    if (manifest) manifests.push({ ...manifest, _dir: dir });
  }
  return manifests;
}
