import { resolve } from "node:path";
import type { ExtensionManifest } from "../types/extension.ts";
import { isBuiltinCliName } from "../shared/cli-builtin-commands.ts";

/**
 * Which `ppm <name>` commands enabled extensions contribute (`contributes.cli`). Shared by the
 * CLI, which registers them, and the chat, which tells the AI they exist. Reading them starts no
 * extension worker: the manifests come from disk (CLI) or from the extensions table (server).
 */

export const CLI_ALIAS_NAME = /^[a-z][a-z0-9-]{1,30}$/;

export interface CliAlias {
  name: string;
  description?: string;
  command: string;
  extensionId: string;
}

export interface RefusedCliAlias {
  name: string;
  extensionId: string;
  reason: "invalid-name" | "builtin" | "undeclared-command" | "duplicate";
}

/**
 * The aliases the given enabled extensions may have, and the ones refused with why. When two
 * extensions claim one name, the extension id that sorts first keeps it, so the winner does not
 * depend on the order extensions were installed in.
 */
export function collectCliAliases(
  manifests: readonly ExtensionManifest[],
  isEnabled: (id: string) => boolean,
): { aliases: CliAlias[]; refused: RefusedCliAlias[] } {
  const aliases: CliAlias[] = [];
  const refused: RefusedCliAlias[] = [];
  const taken = new Set<string>();
  const sorted = [...manifests].filter((m) => isEnabled(m.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const manifest of sorted) {
    const entries = Array.isArray(manifest.contributes?.cli) ? manifest.contributes!.cli! : [];
    const declared = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
    for (const entry of entries) {
      const name = typeof entry?.name === "string" ? entry.name : "";
      const refuse = (reason: RefusedCliAlias["reason"]) => refused.push({ name, extensionId: manifest.id, reason });
      if (!CLI_ALIAS_NAME.test(name)) { refuse("invalid-name"); continue; }
      if (isBuiltinCliName(name)) { refuse("builtin"); continue; }
      if (typeof entry.command !== "string" || !declared.has(entry.command)) { refuse("undeclared-command"); continue; }
      if (taken.has(name)) { refuse("duplicate"); continue; }
      taken.add(name);
      aliases.push({
        name,
        command: entry.command,
        extensionId: manifest.id,
        ...(typeof entry.description === "string" && entry.description ? { description: entry.description } : {}),
      });
    }
  }
  return { aliases, refused };
}

/**
 * The aliases of every enabled extension, read the way the CLI can afford to: manifests from
 * disk (bundled and user-installed), the enabled flag from the database. An extension on disk
 * with no database row yet counts as enabled, since that is what the server's startup would
 * record for it.
 */
export async function readEnabledCliAliases(): Promise<{ aliases: CliAlias[]; refused: RefusedCliAlias[] }> {
  const { bundledExtensionsDir, discoverBundledManifests, discoverManifests } = await import("./extension-manifest.ts");
  const { getPpmDir } = await import("./ppm-dir.ts");
  const { getExtensions } = await import("./db.service.ts");

  const bundled = await discoverBundledManifests(bundledExtensionsDir());
  const user = await discoverManifests(resolve(getPpmDir(), "extensions"));
  // User-installed overrides bundled for the same id, as in the server's own discovery.
  const byId = new Map<string, ExtensionManifest>();
  for (const { _dir: _ignored, ...m } of bundled) byId.set(m.id, m);
  for (const m of user) byId.set(m.id, m);

  const enabled = new Map(getExtensions().map((row) => [row.id, row.enabled === 1]));
  return collectCliAliases([...byId.values()], (id) => enabled.get(id) ?? true);
}
