import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { ExtensionManifest } from "../types/extension.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("ExtService");

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
  // Null drops the extension out of discovery without a trace, so say why.
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const manifest = parseManifest(raw);
    if (!manifest) log.warn(`Invalid extension manifest ${dir}: package.json needs name, version and main`);
    return manifest;
  } catch (e) {
    log.warn(`Invalid extension manifest ${dir}: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/** True when a manifest carries at least one of the three PPM markers. `engines.ppm` is
 * decorative — stored but never version-checked — yet it still counts as a marker: an
 * extension author who only fills that field should not be silently dropped. */
export function hasPpmMarker(m: ExtensionManifest): boolean {
  return !!m.ppm || !!m.contributes || !!m.engines?.ppm;
}

/**
 * Discover user-installed extensions under `<extensionsDir>/node_modules`.
 *
 * The candidate id set is the union of:
 *  - keys of `dependencies` in `<extensionsDir>/package.json` — packages `bun add` installed;
 *  - symlinked entries directly under `node_modules`, including symlinks nested one level
 *    under an `@scope` directory — dev-links (`devLinkExtension`) are never recorded in
 *    `dependencies`, so they would otherwise be invisible here.
 *
 * A candidate only becomes a discovered extension once its manifest passes `hasPpmMarker` —
 * without that check, any transitive dependency of a real extension (installed flat by `bun
 * add`, see extension-installer.ts) would be registered and auto-activated as if it were an
 * extension in its own right.
 */
export async function discoverManifests(extensionsDir: string): Promise<ExtensionManifest[]> {
  const nodeModulesDir = resolve(extensionsDir, "node_modules");
  if (!existsSync(nodeModulesDir)) return [];

  const ids = new Set<string>();

  // Declared dependencies (npm-installed packages).
  const pkgJsonPath = resolve(extensionsDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const deps = pkg.dependencies as Record<string, unknown> | undefined;
      if (deps && typeof deps === "object") {
        for (const dep of Object.keys(deps)) ids.add(dep);
      }
    } catch {
      // Invalid package.json → treat as if there were no declared dependencies; symlink
      // scanning below still finds dev-linked extensions.
    }
  }

  // Symlinked entries under node_modules — dev-links, which never appear in `dependencies`.
  const entries = await readdir(nodeModulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".bin") continue;

    if (entry.name.startsWith("@")) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const scopeDir = resolve(nodeModulesDir, entry.name);
      const scopedEntries = await readdir(scopeDir, { withFileTypes: true });
      for (const scoped of scopedEntries) {
        if (scoped.isSymbolicLink()) ids.add(`${entry.name}/${scoped.name}`);
      }
    } else if (entry.isSymbolicLink()) {
      ids.add(entry.name);
    }
  }

  const manifests: ExtensionManifest[] = [];
  for (const id of ids) {
    const manifest = readManifestAt(resolve(nodeModulesDir, id));
    if (manifest && hasPpmMarker(manifest)) manifests.push(manifest);
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
