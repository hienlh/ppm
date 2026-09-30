import { join } from "node:path";
import { parseDesignVariants, type ParsedVariants } from "../../shared/design-variants.ts";
import { lstatOrNull } from "./design-paths.ts";
import type { DesignManifest } from "./design-manifest.ts";

/**
 * The variants a design really has: `design.json`'s list, validated, minus the files that do
 * not exist. An agent often writes the manifest before the pages it names, and a variant the
 * canvas switched to would then load a 404 instead of a page, so a missing file is left out
 * with a warning until it appears. A symlink is not a variant either: the preview route would
 * refuse to serve it. The entry is always kept, existing or not, exactly as before variants.
 */
export async function resolveDesignVariants(designDir: string, manifest: DesignManifest): Promise<ParsedVariants> {
  const parsed = parseDesignVariants(manifest.extra.variants, manifest.entry);
  const [entry, ...others] = parsed.variants;
  const kept = [entry!];
  const warnings = [...parsed.warnings];
  for (const variant of others) {
    const st = await lstatOrNull(join(designDir, variant.file));
    if (st?.isFile()) kept.push(variant);
    else warnings.push(`${variant.file} is listed in design.json but is not a file in the design folder yet.`);
  }
  return { variants: kept, warnings };
}
