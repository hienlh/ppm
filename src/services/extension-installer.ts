import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import type { ExtensionManifest } from "../types/extension.ts";
import { getExtensionById, insertExtension, updateExtension, deleteExtension, deleteExtensionStorage } from "./db.service.ts";
import { readManifestAt } from "./extension-manifest.ts";

const INSTALL_TIMEOUT = 60_000;
const NPM_PACKAGE_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[^@]+)?$/;

/** Ensure ~/.ppm/extensions/ dir + isolated package.json exist */
export function ensureExtensionsDir(extensionsDir: string): void {
  if (!existsSync(extensionsDir)) {
    mkdirSync(extensionsDir, { recursive: true });
  }
  const pkgJsonPath = resolve(extensionsDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: "ppm-extensions", private: true, dependencies: {} }, null, 2));
  }
}

/** Install an npm package into the extensions directory and persist to DB */
export async function installExtension(name: string, extensionsDir: string): Promise<ExtensionManifest> {
  if (!NPM_PACKAGE_RE.test(name)) throw new Error(`Invalid package name: ${name}`);
  ensureExtensionsDir(extensionsDir);

  const proc = Bun.spawn(["bun", "add", name], {
    cwd: extensionsDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => proc.kill(), INSTALL_TIMEOUT);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Install failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  const pkgDir = resolve(extensionsDir, "node_modules", name);
  const manifest = readManifestAt(pkgDir);
  if (!manifest) throw new Error(`Installed ${name} but no valid manifest found`);

  upsertExtensionInDb(manifest);
  console.log(`[ExtService] Installed ${manifest.id}@${manifest.version}`);
  return manifest;
}

/** Remove an extension from disk + DB */
export async function removeExtension(id: string, extensionsDir: string): Promise<void> {
  try {
    const proc = Bun.spawn(["bun", "remove", id], {
      cwd: extensionsDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } catch (e) {
    console.error(`[ExtService] npm remove ${id} failed (DB record still removed):`, e);
  }

  deleteExtensionStorage(id);
  deleteExtension(id);
  console.log(`[ExtService] Removed ${id}`);
}

/** Symlink a local extension path for development */
export function devLinkExtension(localPath: string, extensionsDir: string): ExtensionManifest {
  const absPath = resolve(localPath);
  const manifest = readManifestAt(absPath);
  if (!manifest) throw new Error(`No valid package.json at ${absPath}`);

  ensureExtensionsDir(extensionsDir);
  const nodeModules = resolve(extensionsDir, "node_modules");
  if (!existsSync(nodeModules)) mkdirSync(nodeModules, { recursive: true });

  const targetDir = resolve(nodeModules, manifest.id);
  const parentDir = resolve(targetDir, "..");
  if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  symlinkSync(absPath, targetDir, "dir");

  upsertExtensionInDb(manifest);
  console.log(`[ExtService] Dev-linked ${manifest.id} → ${absPath}`);
  return manifest;
}

/** Insert or update extension record in DB */
function upsertExtensionInDb(manifest: ExtensionManifest): void {
  const existing = getExtensionById(manifest.id);
  if (existing) {
    updateExtension(manifest.id, {
      version: manifest.version,
      display_name: manifest.displayName ?? null,
      description: manifest.description ?? null,
      icon: manifest.icon ?? null,
      manifest: JSON.stringify(manifest),
    });
  } else {
    insertExtension({
      id: manifest.id,
      version: manifest.version,
      display_name: manifest.displayName ?? null,
      description: manifest.description ?? null,
      icon: manifest.icon ?? null,
      enabled: 1,
      manifest: JSON.stringify(manifest),
    });
  }
}
