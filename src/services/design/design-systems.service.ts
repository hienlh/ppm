import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import simpleGit from "simple-git";
import { isDesignPlatform, type DesignSystemSummary } from "../../shared/design-types.ts";
import { lstatOrNull, resolveDesignDir, resolveDesignsRoot } from "./design-paths.ts";
import { manifestSystemId } from "./design-manifest-system.ts";
import { ensureDotDesign, mkdirIfMissing, writeFileAtomic } from "./design-fs.ts";
import { designLockKey, withDesignLock } from "./design-lock.ts";
import { DesignError } from "./design-error.ts";
import { slugFromTitle } from "./design-slug.ts";
import {
  DEFAULT_SYSTEM_ID, isValidSystemId, normalizeSystemRoot, parseSystemFile, serializeSystemFile,
  systemAppRoot, systemDeclDir, systemFilesDir, systemsRoot, SYSTEM_FILE, type ParsedSystemFile,
} from "./design-systems-paths.ts";

/**
 * Declared apps ("design systems") of a project: CRUD over `designs/systems/<id>/system.json`,
 * plus the `default` app, which is never declared on disk under normal use but can hold its
 * own `system.json` (label/platform/builtFrom only — its `root` always stays `.` and its
 * design-system files always stay at the legacy `designs/` root).
 *
 * Every mutation runs under the design-file lock keyed `system:<id>`, the same mutex used for
 * a design's own files, so a concurrent edit and a concurrent `builtFrom` record never race.
 */

const MAX_SYSTEM_FILE_BYTES = 64 * 1024;
const MAX_ID_SUFFIX = 999;

function systemLockKey(projectPath: string, id: string): string {
  return designLockKey(projectPath, `system:${id}`);
}

/** `designs/systems/<id>/`, creating both it and its `systems/` parent if either is missing. */
async function ensureSystemDeclDir(designsRootAbs: string, id: string): Promise<string> {
  await mkdirIfMissing(systemsRoot(designsRootAbs));
  const dir = systemDeclDir(designsRootAbs, id);
  await mkdirIfMissing(dir);
  return dir;
}

async function readSystemFileRaw(dir: string): Promise<string | null> {
  const path = join(dir, SYSTEM_FILE);
  const st = await lstatOrNull(path);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size > MAX_SYSTEM_FILE_BYTES) return null;
  return readFile(path, "utf8");
}

async function regularFileStat(path: string) {
  const st = await lstatOrNull(path);
  return st?.isFile() ? st : null;
}

async function summarizeSystem(projectRoot: string, designsRootAbs: string | null, id: string): Promise<DesignSystemSummary> {
  const raw = designsRootAbs ? await readSystemFileRaw(systemDeclDir(designsRootAbs, id)) : null;
  if (id !== DEFAULT_SYSTEM_ID && raw === null) throw new DesignError(404, "ENOENT", `App not found: ${id}`);
  const file: ParsedSystemFile = raw !== null
    ? parseSystemFile(raw, { id, projectRoot: projectRoot })
    : { label: id === DEFAULT_SYSTEM_ID ? "Default" : id, root: ".", platform: "web" };
  const filesDir = designsRootAbs ? systemFilesDir(designsRootAbs, id) : null;
  const [designMd, tokensCss] = filesDir
    ? await Promise.all([regularFileStat(join(filesDir, "DESIGN.md")), regularFileStat(join(filesDir, "tokens.css"))])
    : [null, null];
  return {
    id,
    label: file.label,
    root: id === DEFAULT_SYSTEM_ID ? "." : file.root,
    platform: file.platform,
    declared: raw !== null,
    ...(file.builtFrom ? { builtFrom: file.builtFrom } : {}),
    hasDesignMd: !!designMd,
    hasTokensCss: !!tokensCss,
  };
}

/** Every app of the project: `default` first, then declared apps sorted by label. */
export async function listDesignSystems(projectPath: string): Promise<DesignSystemSummary[]> {
  const project = resolve(projectPath);
  const root = await resolveDesignsRoot(project);
  const ids = new Set<string>([DEFAULT_SYSTEM_ID]);
  if (root) {
    const dir = systemsRoot(root);
    const st = await lstatOrNull(dir);
    if (st?.isDirectory() && !st.isSymbolicLink()) {
      for (const name of await readdir(dir)) {
        if (!isValidSystemId(name)) continue;
        const entryDir = join(dir, name);
        const entrySt = await lstatOrNull(entryDir);
        if (!entrySt || entrySt.isSymbolicLink() || !entrySt.isDirectory()) continue;
        // A folder counts as a declared app only while its system.json exists; one left
        // behind by an "un-declare, keep the files" removal is orphaned on purpose, still
        // reachable by any design that names it, but no longer offered as an app.
        if ((await readSystemFileRaw(entryDir)) !== null) ids.add(name);
      }
    }
  }
  const summaries = await Promise.all([...ids].map((id) => summarizeSystem(project, root, id)));
  summaries.sort((a, b) => (a.id === DEFAULT_SYSTEM_ID ? -1 : b.id === DEFAULT_SYSTEM_ID ? 1 : a.label.localeCompare(b.label)));
  return summaries;
}

export async function getDesignSystem(projectPath: string, id: string): Promise<DesignSystemSummary> {
  if (!isValidSystemId(id)) throw new DesignError(400, "EBADSYSTEM", "Invalid app id");
  const project = resolve(projectPath);
  const root = await resolveDesignsRoot(project);
  return summarizeSystem(project, root, id);
}

/** The app a design belongs to, read from its own `design.json`. Falls back to `default`. */
export async function resolveSystemForDesign(projectPath: string, slug: string): Promise<DesignSystemSummary> {
  try {
    // Lazy: avoids a load-time cycle with design-store.service.ts, which calls back into this
    // module too (to validate a design's `system` input on create).
    const { loadManifest } = await import("./design-store.service.ts");
    const dir = await resolveDesignDir(projectPath, slug);
    const { manifest } = await loadManifest(dir, slug);
    return await getDesignSystem(projectPath, manifestSystemId(manifest));
  } catch {
    return getDesignSystem(projectPath, DEFAULT_SYSTEM_ID);
  }
}

export interface DesignSystemInput {
  id?: unknown;
  label?: unknown;
  root?: unknown;
  platform?: unknown;
}

function normalizeLabelInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.slice(0, 80) : null;
}

/** Declare a new app. The id comes from `label` unless `id` is given (and a valid slug). */
export async function createDesignSystem(projectPath: string, input: DesignSystemInput): Promise<DesignSystemSummary> {
  const project = resolve(projectPath);
  const label = normalizeLabelInput(input.label);
  if (!label) throw new DesignError(400, "EBADLABEL", "An app needs a label");
  if (!isDesignPlatform(input.platform)) throw new DesignError(400, "EBADPLATFORM", "Unknown platform");
  const normalizedRoot = normalizeSystemRoot(project, input.root ?? ".");
  if (normalizedRoot === null) throw new DesignError(400, "EBADROOT", "Invalid app folder");
  const explicitId = typeof input.id === "string" && isValidSystemId(input.id) ? input.id : null;
  const base = explicitId ?? (slugFromTitle(label) || "app");
  const designsRootAbs = await resolveDesignsRoot(project, { create: true });
  if (!designsRootAbs) throw new DesignError(500, "EDESIGNROOT", "Could not create designs/");
  await mkdirIfMissing(systemsRoot(designsRootAbs));

  for (let n = 1; n <= MAX_ID_SUFFIX; n++) {
    const id = n === 1 ? base : `${base.slice(0, 63 - String(n).length - 1)}-${n}`;
    const dir = systemDeclDir(designsRootAbs, id);
    try {
      await mkdir(dir);
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") continue;
      throw e;
    }
    const file: ParsedSystemFile = { label, root: id === DEFAULT_SYSTEM_ID ? "." : normalizedRoot, platform: input.platform };
    await writeFileAtomic(join(dir, SYSTEM_FILE), serializeSystemFile(file));
    return summarizeSystem(project, designsRootAbs, id);
  }
  throw new DesignError(409, "EEXIST", "Too many apps share this name");
}

/** Edit an existing declared app, or `default` (which may not have a file yet). */
export async function updateDesignSystem(projectPath: string, id: string, input: DesignSystemInput): Promise<DesignSystemSummary> {
  if (!isValidSystemId(id)) throw new DesignError(400, "EBADSYSTEM", "Invalid app id");
  const project = resolve(projectPath);
  const designsRootAbs = await resolveDesignsRoot(project, { create: true });
  if (!designsRootAbs) throw new DesignError(500, "EDESIGNROOT", "Could not create designs/");
  const dir = systemDeclDir(designsRootAbs, id);

  return withDesignLock(systemLockKey(project, id), async () => {
    const raw = await readSystemFileRaw(dir);
    if (id !== DEFAULT_SYSTEM_ID && raw === null) throw new DesignError(404, "ENOENT", `App not found: ${id}`);
    const current = parseSystemFile(raw, { id, projectRoot: project });
    const label = input.label !== undefined ? normalizeLabelInput(input.label) : current.label;
    if (!label) throw new DesignError(400, "EBADLABEL", "An app needs a label");
    let root = current.root;
    if (id !== DEFAULT_SYSTEM_ID && input.root !== undefined) {
      const next = normalizeSystemRoot(project, input.root);
      if (next === null) throw new DesignError(400, "EBADROOT", "Invalid app folder");
      root = next;
    }
    let platform = current.platform;
    if (input.platform !== undefined) {
      if (!isDesignPlatform(input.platform)) throw new DesignError(400, "EBADPLATFORM", "Unknown platform");
      platform = input.platform;
    }
    const next: ParsedSystemFile = { ...current, label, root: id === DEFAULT_SYSTEM_ID ? "." : root, platform };
    await ensureSystemDeclDir(designsRootAbs, id);
    await writeFileAtomic(join(dir, SYSTEM_FILE), serializeSystemFile(next));
    return summarizeSystem(project, designsRootAbs, id);
  });
}

/** Un-declare an app (its `system.json`), optionally also deleting its design-system files. */
export async function deleteDesignSystem(projectPath: string, id: string, opts: { deleteFiles?: boolean } = {}): Promise<void> {
  if (!isValidSystemId(id) || id === DEFAULT_SYSTEM_ID) {
    throw new DesignError(400, "EBADSYSTEM", "The default app cannot be removed");
  }
  const project = resolve(projectPath);
  const designsRootAbs = await resolveDesignsRoot(project);
  if (!designsRootAbs) throw new DesignError(404, "ENOENT", `App not found: ${id}`);
  const dir = systemDeclDir(designsRootAbs, id);
  await withDesignLock(systemLockKey(project, id), async () => {
    const st = await lstatOrNull(dir);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new DesignError(404, "ENOENT", `App not found: ${id}`);
    if (opts.deleteFiles) {
      await rm(dir, { recursive: true, force: false });
    } else {
      await rm(join(dir, SYSTEM_FILE), { force: true });
    }
  });
}

/**
 * Record `git rev-parse HEAD` of the app's real root, server-side, after a setup turn. A
 * no-op when the root is not inside a git repository — `builtFrom` then stays whatever it
 * was (or absent), and the stale check reports "unknown" rather than guessing.
 */
export async function recordBuiltFrom(projectPath: string, id: string): Promise<void> {
  if (!isValidSystemId(id)) return;
  const project = resolve(projectPath);
  const designsRootAbs = await resolveDesignsRoot(project, { create: true });
  if (!designsRootAbs) return;
  let system: DesignSystemSummary;
  try {
    system = await summarizeSystem(project, designsRootAbs, id);
  } catch {
    return;
  }
  let commit: string;
  try {
    commit = (await simpleGit(systemAppRoot(project, system.root)).revparse(["HEAD"])).trim();
  } catch {
    return;
  }
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return;
  const dir = systemDeclDir(designsRootAbs, id);
  await withDesignLock(systemLockKey(project, id), async () => {
    const current = parseSystemFile(await readSystemFileRaw(dir), { id, projectRoot: project });
    await ensureSystemDeclDir(designsRootAbs, id);
    await writeFileAtomic(join(dir, SYSTEM_FILE), serializeSystemFile({ ...current, builtFrom: { commit, at: new Date().toISOString() } }));
  });
}
