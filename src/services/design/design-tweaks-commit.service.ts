import { join } from "node:path";
import { DESIGN_GEN_RE } from "../../shared/design-types.ts";
import {
  MAX_TWEAKS, TWEAK_VAR_RE, parseTweaks, sanitizeTweakValue, type ParsedTweaks,
} from "../../shared/design-tweaks.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";
import { resolveDesignDir, lstatOrNull } from "./design-paths.ts";
import { MANIFEST_FILE, isSafeEntry, parseManifest } from "./design-manifest.ts";
import { snapshotDesign } from "./design-snapshots.service.ts";
import { DesignError } from "./design-error.ts";
import { readDesignSource, writeDesignSource } from "./source/design-source-file.ts";
import { styleSources } from "./source/design-style-sources.ts";
import { planTweakPatches, type PlannedTweak } from "./source/tweak-patch-plan.ts";

/**
 * "Apply" in the Tweaks panel: write the chosen values into the design's stylesheets.
 *
 * The request carries only variable names and values, never a position or a file to write:
 * the server re-reads the manifest, validates each value against its tweak's allowlist,
 * works out which declaration wins on screen (see `tweak-patch-plan.ts`) and splices only
 * that. Every design file it reads must still have the gen the canvas reported for it —
 * the entry HTML and each linked stylesheet — or the whole commit is a 409 naming the file,
 * so a canvas that is behind an agent's edit can never have its view written back over it.
 * The `before-edit` snapshot is taken only once the commit is known to go through.
 */

const MAX_MANIFEST_BYTES = 256 * 1024;

export interface TweakCommitInput {
  entry: string;
  gens: Record<string, string>;
  values: Record<string, string>;
}

export interface TweakCommitResult {
  /** Current gen of every design file the commit read, rewritten ones included. */
  gens: Record<string, string>;
}

export interface DesignTweaksInfo extends ParsedTweaks {
  /** False when `design.json` is missing or not a JSON object; the panel is then hidden. */
  manifestValid: boolean;
}

/** A stale gen: the design changed since the canvas loaded it. */
export class StaleTweakGenError extends DesignError {
  constructor(readonly file: string, readonly currentGen: string) {
    super(409, "ESTALE", `${file} changed since the canvas loaded it`);
  }
}

const bad = (message: string): DesignError => new DesignError(400, "EBADTWEAK", message);
type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);

async function readTweaksIn(designDir: string, slug: string): Promise<DesignTweaksInfo> {
  const path = join(designDir, MANIFEST_FILE);
  const st = await lstatOrNull(path);
  if (!st?.isFile() || st.size > MAX_MANIFEST_BYTES) return { manifestValid: false, tweaks: [], errors: [] };
  let raw: string;
  try {
    raw = (await readDesignSource(path, { maxBytes: MAX_MANIFEST_BYTES })).text;
  } catch (e) {
    if (e instanceof DesignError && e.status === 422) return { manifestValid: false, tweaks: [], errors: [] };
    throw e;
  }
  const parsed = parseManifest(raw, { slug, now: new Date(0).toISOString() });
  return { manifestValid: parsed.valid, ...parseTweaks(parsed.manifest.extra.tweaks) };
}

/** The tweak controls `design.json` declares, with the reasons any entry was skipped. */
export async function readDesignTweaks(projectPath: string, slug: string): Promise<DesignTweaksInfo> {
  return readTweaksIn(await resolveDesignDir(projectPath, slug), slug);
}

export function parseTweakCommitInput(input: unknown): TweakCommitInput {
  if (!isRaw(input)) throw bad("Expected a JSON object");
  if (!isSafeEntry(input.entry)) throw bad("entry must be an HTML file of the design");
  if (!isRaw(input.gens) || Object.keys(input.gens).length > 64) throw bad("gens must map files to gens");
  const gens: Record<string, string> = {};
  for (const [file, gen] of Object.entries(input.gens)) {
    if (file.length > 512 || typeof gen !== "string" || !DESIGN_GEN_RE.test(gen)) throw bad("gens must map files to gens");
    gens[file] = gen;
  }
  if (!isRaw(input.values)) throw bad("values must map variables to values");
  const entries = Object.entries(input.values);
  if (entries.length === 0) throw bad("Nothing to apply");
  if (entries.length > MAX_TWEAKS) throw bad(`At most ${MAX_TWEAKS} values per commit`);
  const values: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!TWEAK_VAR_RE.test(name) || typeof value !== "string") throw bad(`Invalid value for ${name.slice(0, 60)}`);
    values[name] = value;
  }
  return { entry: input.entry, gens, values };
}

export async function commitTweaks(projectPath: string, slug: string, raw: unknown): Promise<TweakCommitResult> {
  const input = parseTweakCommitInput(raw);
  return withRecoveredDesign(projectPath, slug, async (designDir) => {
    const { tweaks } = await readTweaksIn(designDir, slug);
    const planned: PlannedTweak[] = Object.entries(input.values).map(([name, value]) => {
      const def = tweaks.find((t) => t.var === name);
      if (!def) throw bad(`${name} is not a tweak of this design`);
      const safe = sanitizeTweakValue(def, value);
      if (safe === null) throw bad(`"${def.label}" cannot be set to that value`);
      return { def, value: safe };
    });

    const loaded = await styleSources({ projectPath, slug }, input.entry);
    for (const [file, { source, outside }] of loaded.files) {
      // The shared tokens.css is never written and the canvas holds no gen for it.
      if (!outside && input.gens[file] !== source.gen) throw new StaleTweakGenError(file, source.gen);
    }
    const texts = new Map([...loaded.files].map(([file, f]) => [file, f.source.text] as const));
    const patches = planTweakPatches(input.entry, loaded.sources, texts, planned);

    const gens: Record<string, string> = {};
    for (const [file, { source, outside }] of loaded.files) if (!outside) gens[file] = source.gen;
    if (patches.size === 0) return { gens };
    await snapshotDesign(projectPath, slug, "before-edit");
    for (const [file, text] of patches) {
      const f = loaded.files.get(file)!;
      gens[file] = await writeDesignSource(f.abs, text, { bom: f.source.bom });
    }
    return { gens };
  });
}
