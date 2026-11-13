import { getExtensions } from "./db.service.ts";
import { collectCliAliases, type CliAlias } from "./extension-cli-aliases.ts";
import type { ExtensionManifest } from "../types/extension.ts";

/**
 * One line added to every chat's instructions naming the `ppm <name>` commands enabled
 * extensions contribute, so the agent knows it can run them through its shell. Server-built:
 * whatever a caller sends under this name is discarded, as for design instructions.
 *
 * Cached, because it is read on every turn and the extension list changes only when an
 * extension is installed, removed, enabled, disabled or (re)activated; those paths call
 * {@link invalidateExtensionCliHint}.
 */

const MAX_ALIASES = 6;
const MAX_DESCRIPTION_CHARS = 80;

/**
 * An extension's description goes into the system prompt, so it is reduced to one plain line:
 * no control characters, no backticks to break out of the quoting, bounded length. Installing an
 * extension is already full trust (it runs code in the host); this keeps a sloppy manifest from
 * reshaping the prompt.
 */
function sanitizeDescription(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f`]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…` : flat;
}

/** The line for these aliases, or "" when there are none. */
export function formatExtensionCliHint(aliases: ReadonlyArray<Pick<CliAlias, "name" | "description">>): string {
  if (aliases.length === 0) return "";
  const shown = aliases.slice(0, MAX_ALIASES).map((a) => {
    const description = a.description ? sanitizeDescription(a.description) : "";
    return description ? `\`ppm ${a.name}\` (${description})` : `\`ppm ${a.name}\``;
  });
  const list = aliases.length > MAX_ALIASES ? `${shown.join(", ")}, …` : shown.join(", ");
  return `PPM extension commands are available through Bash: ${list}. `
    + "Run `ppm <name> --help` for usage; add --json for machine-readable output.";
}

let cached: string | undefined;

/** The line for the enabled extensions as the database records them, or undefined for none. */
export function extensionCliHint(): string | undefined {
  if (cached === undefined) {
    try {
      const rows = getExtensions();
      const manifests: ExtensionManifest[] = [];
      for (const row of rows) {
        try { manifests.push(JSON.parse(row.manifest) as ExtensionManifest); } catch { /* unreadable row: no aliases */ }
      }
      const enabled = new Set(rows.filter((r) => r.enabled === 1).map((r) => r.id));
      cached = formatExtensionCliHint(collectCliAliases(manifests, (id) => enabled.has(id)).aliases);
    } catch {
      // A hint is never worth failing a turn over.
      return undefined;
    }
  }
  return cached || undefined;
}

export function invalidateExtensionCliHint(): void {
  cached = undefined;
}
