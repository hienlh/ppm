import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesignSummary } from "../../shared/design-types.ts";
import { lstatOrNull, resolveDesignDir } from "./design-paths.ts";
import { ensureDotDesign } from "./design-fs.ts";
import { DEFAULT_ENTRY, MANIFEST_FILE, serializeManifest, type DesignManifest } from "./design-manifest.ts";
import { getDesign, loadManifest, summarize } from "./design-store.service.ts";
import { manifestShowcaseFor, showcaseSlugFor, systemManifestFields } from "./design-manifest-system.ts";
import { getDesignSystem, recordBuiltFrom } from "./design-systems.service.ts";
import { showcaseStarterHtml } from "./design-systems-showcase-template.ts";

/**
 * The showcase design of an app: an ordinary design at the fixed slug `system-<id>`, created
 * on first use ("Set up design system") and reused afterwards — the More menu and the New
 * Design dialog's "Set up first" step both call this rather than creating a fresh design
 * every time.
 */
export async function ensureShowcaseDesign(projectPath: string, systemId: string): Promise<DesignSummary> {
  const system = await getDesignSystem(projectPath, systemId); // throws 404 for an unknown declared app
  const slug = showcaseSlugFor(systemId);
  const dir = await resolveDesignDir(projectPath, slug, { mustExist: false });
  if (await lstatOrNull(dir)) return getDesign(projectPath, slug);

  try {
    await mkdir(dir);
  } catch (e) {
    if ((e as { code?: string }).code === "EEXIST") return getDesign(projectPath, slug);
    throw e;
  }
  try {
    const now = new Date().toISOString();
    const manifest: DesignManifest = {
      title: `${system.label} design system`, kind: "page", entry: DEFAULT_ENTRY, createdAt: now, updatedAt: now,
      extra: { tweaks: [], ...systemManifestFields(systemId, systemId) },
    };
    await ensureDotDesign(dir);
    await writeFile(join(dir, DEFAULT_ENTRY), showcaseStarterHtml(system));
    await writeFile(join(dir, MANIFEST_FILE), serializeManifest(manifest));
    return summarize(dir, slug, manifest);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Called after every turn snapshot: if `slug` is an app's showcase design, record the app
 * root's current commit as `builtFrom`. Best-effort — a design that is not a showcase, or an
 * app root with no git repository, is silently a no-op.
 */
export async function recordBuiltFromIfShowcase(projectPath: string, slug: string): Promise<void> {
  try {
    const dir = await resolveDesignDir(projectPath, slug);
    const { manifest } = await loadManifest(dir, slug);
    const systemId = manifestShowcaseFor(manifest);
    if (systemId) await recordBuiltFrom(projectPath, systemId);
  } catch (e) {
    console.warn(`[design] could not record builtFrom for ${slug}: ${(e as Error).message}`);
  }
}
