import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";
import {
  isDesignKind, type DesignKind, type DesignSummary, type DesignSystemStatus,
} from "../../shared/design-types.ts";
import { isValidDesignSlug, slugFromTitle } from "./design-slug.ts";
import { lstatOrNull, resolveDesignDir, resolveDesignsRoot } from "./design-paths.ts";
import { ensureDotDesign, writeFileAtomic } from "./design-fs.ts";
import {
  DEFAULT_ENTRY, MANIFEST_FILE, normalizeTitle, parseManifest, serializeManifest, type DesignManifest,
} from "./design-manifest.ts";
import { starterHtml } from "./design-starter-template.ts";
import { DesignError } from "./design-error.ts";
import { designLockKey, withDesignLock } from "./design-lock.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";

/** Designs listed per project, newest first. */
export const MAX_LISTED_DESIGNS = 200;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_SLUG_SUFFIX = 999;

async function readManifestRaw(designDir: string): Promise<string | null> {
  const path = join(designDir, MANIFEST_FILE);
  const st = await lstatOrNull(path);
  if (!st || !st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
  return readFile(path, "utf8");
}

async function regularFileStat(path: string): Promise<Stats | null> {
  const st = await lstatOrNull(path);
  return st?.isFile() ? st : null;
}

async function summarize(designDir: string, slug: string, manifest: DesignManifest): Promise<DesignSummary> {
  const entry = await regularFileStat(join(designDir, ...manifest.entry.split("/")));
  const updated = Math.max(Date.parse(manifest.updatedAt), entry?.mtimeMs ?? 0);
  const { title, kind, createdAt } = manifest;
  return { slug, title, kind, entry: manifest.entry, createdAt, updatedAt: new Date(updated).toISOString() };
}

async function loadManifest(designDir: string, slug: string): Promise<{ manifest: DesignManifest; valid: boolean; raw: string | null }> {
  const dirSt = await lstatOrNull(designDir);
  // A manifest without timestamps falls back to the folder's own age, not "now", so a
  // hand-made design does not jump to the top of the list on every read.
  const now = new Date(dirSt?.birthtimeMs || dirSt?.mtimeMs || Date.now()).toISOString();
  const raw = await readManifestRaw(designDir);
  return { ...parseManifest(raw, { slug, now }), raw };
}

export async function getDesign(projectPath: string, slug: string): Promise<DesignSummary> {
  const dir = await resolveDesignDir(projectPath, slug);
  return summarize(dir, slug, (await loadManifest(dir, slug)).manifest);
}

/**
 * Every design folder under `designs/`, newest first, at most {@link MAX_LISTED_DESIGNS}.
 * A folder counts as a design when its name is a valid slug and it holds a manifest or an
 * entry page; symlinked folders are never listed.
 */
export async function listDesigns(projectPath: string): Promise<DesignSummary[]> {
  const root = await resolveDesignsRoot(projectPath);
  if (!root) return [];
  const out: DesignSummary[] = [];
  for (const name of await readdir(root)) {
    if (!isValidDesignSlug(name)) continue;
    const dir = join(root, name);
    const st = await lstatOrNull(dir);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    const hasManifest = await regularFileStat(join(dir, MANIFEST_FILE));
    if (!hasManifest && !(await regularFileStat(join(dir, DEFAULT_ENTRY)))) continue;
    try {
      out.push(await summarize(dir, name, (await loadManifest(dir, name)).manifest));
    } catch (e) {
      console.warn(`[design] skipping ${dir}: ${(e as Error).message}`);
    }
  }
  return out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, MAX_LISTED_DESIGNS);
}

function candidateSlug(base: string, n: number): string {
  if (n === 1) return base;
  const suffix = `-${n}`;
  return `${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/**
 * Create `designs/<slug>/` with a starter page, the manifest and `.design/.gitignore`.
 * The slug comes from the title; a taken slug gets `-2`, `-3`… The folder is claimed with a
 * non-recursive mkdir, which fails if it already exists, so two creates racing for one
 * title end up in two folders rather than one overwriting the other.
 */
export async function createDesign(projectPath: string, input: { title: unknown; kind: unknown }): Promise<DesignSummary> {
  const title = normalizeTitle(input.title);
  if (!title) throw new DesignError(400, "EBADTITLE", "A design needs a title");
  if (input.kind !== undefined && !isDesignKind(input.kind)) throw new DesignError(400, "EBADKIND", "Unknown design kind");
  const kind: DesignKind = isDesignKind(input.kind) ? input.kind : "page";
  const root = await resolveDesignsRoot(projectPath, { create: true });
  if (!root) throw new DesignError(500, "EDESIGNROOT", "Could not create designs/");
  const base = slugFromTitle(title) || "design";

  for (let n = 1; n <= MAX_SLUG_SUFFIX; n++) {
    const slug = candidateSlug(base, n);
    const dir = join(root, slug);
    try {
      await mkdir(dir);
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") continue;
      throw e;
    }
    try {
      const now = new Date().toISOString();
      const manifest: DesignManifest = { title, kind, entry: DEFAULT_ENTRY, createdAt: now, updatedAt: now, extra: { tweaks: [] } };
      const hasTokens = !!(await regularFileStat(join(root, "tokens.css")));
      await ensureDotDesign(dir);
      await writeFile(join(dir, DEFAULT_ENTRY), starterHtml(kind, title, hasTokens));
      await writeFile(join(dir, MANIFEST_FILE), serializeManifest(manifest));
      return await summarize(dir, slug, manifest);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
  throw new DesignError(409, "EEXIST", "Too many designs share this title");
}

/** Change the title only: the slug is fixed because design sessions carry it in their instructions. */
export async function renameDesign(projectPath: string, slug: string, rawTitle: unknown): Promise<DesignSummary> {
  const title = normalizeTitle(rawTitle);
  if (!title) throw new DesignError(400, "EBADTITLE", "A design needs a title");
  return withRecoveredDesign(projectPath, slug, async (dir) => {
    const { manifest, valid, raw } = await loadManifest(dir, slug);
    // Rewriting an unreadable manifest would replace whatever the agent put there with defaults.
    if (raw !== null && !valid) throw new DesignError(409, "EBADMANIFEST", `${MANIFEST_FILE} is not a valid JSON object`);
    const next: DesignManifest = { ...manifest, title, updatedAt: new Date().toISOString() };
    await writeFileAtomic(join(dir, MANIFEST_FILE), serializeManifest(next));
    return summarize(dir, slug, next);
  });
}

/** Delete a design folder, `.design/` and its history included. */
export async function deleteDesign(projectPath: string, slug: string): Promise<void> {
  await withDesignLock(designLockKey(projectPath, slug), async () => {
    const dir = await resolveDesignDir(projectPath, slug);
    // rm never follows a symlink inside the tree; the folder itself was checked not to be one.
    await rm(dir, { recursive: true, force: false });
  });
}

/** Whether the project design system exists yet (`designs/DESIGN.md`, `designs/tokens.css`). */
export async function designSystemStatus(projectPath: string): Promise<DesignSystemStatus> {
  const root = await resolveDesignsRoot(projectPath);
  if (!root) return { designMd: false, tokensCss: false };
  const [md, css] = await Promise.all([regularFileStat(join(root, "DESIGN.md")), regularFileStat(join(root, "tokens.css"))]);
  return { designMd: !!md, tokensCss: !!css };
}
