/**
 * Where a spec lives: its documents in `<project>/specs/<slug>/`, and PPM's state for it in
 * `<ppm dir>/specs/<project key>/<slug>.json`.
 *
 * The documents belong to the repository (the AI writes them with its ordinary file tools and
 * people review them in git). The state — approvals, runs, the check level — belongs to PPM:
 * nothing an AI tool writes reaches it, so a Thorough spec cannot be turned Standard, or a phase
 * approved, by editing a file in the project.
 *
 * Every path is built from the server-side project path plus a validated slug, and `specs/`
 * and each spec folder must be real directories inside the project (no symlinks), the same
 * rules as `designs/` (`design-paths.ts`).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getPpmDir } from "../ppm-dir.ts";
import { assertAllowed, assertNotPpmDir } from "../fs-path-guard.service.ts";
import { isInsideDir } from "../fs-ops/fs-real-path.ts";
import {
  SPECS_DIR, emptySpecState, isValidSpecSlug, phaseFileName,
  type SpecKind, type SpecPhase, type SpecState,
} from "../../shared/spec-types.ts";

export class SpecError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const lstatOrNull = async (p: string) => {
  try {
    return await lstat(p);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
};

/** `<project>/specs` as a real directory inside the project, or null when absent. */
export async function resolveSpecsRoot(projectPath: string, create = false): Promise<string | null> {
  const project = resolve(projectPath);
  assertAllowed(project);
  const root = join(project, SPECS_DIR);
  assertNotPpmDir(root);
  let st = await lstatOrNull(root);
  if (!st && create) {
    try { await mkdir(root); } catch (e) { if ((e as { code?: string }).code !== "EEXIST") throw e; }
    st = await lstatOrNull(root);
  }
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SpecError(403, "ESPECPATH", `${SPECS_DIR}/ must be a real directory`);
  const [realProject, realRoot] = await Promise.all([realpath(project), realpath(root)]);
  if (!isInsideDir(realRoot, realProject)) throw new SpecError(403, "ESPECPATH", `${SPECS_DIR}/ resolves outside the project`);
  return realRoot;
}

export async function resolveSpecDir(projectPath: string, slug: string, opts: { create?: boolean } = {}): Promise<string> {
  if (!isValidSpecSlug(slug)) throw new SpecError(400, "EBADSLUG", "Invalid spec name");
  const root = await resolveSpecsRoot(projectPath, opts.create);
  if (!root) throw new SpecError(404, "ENOENT", `Spec not found: ${slug}`);
  const dir = join(root, slug);
  let st = await lstatOrNull(dir);
  if (!st && opts.create) {
    await mkdir(dir);
    st = await lstatOrNull(dir);
  }
  if (!st) throw new SpecError(404, "ENOENT", `Spec not found: ${slug}`);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SpecError(403, "ESPECPATH", "A spec folder must be a real directory");
  const real = await realpath(dir);
  if (!isInsideDir(real, root) || real === root) throw new SpecError(403, "ESPECPATH", "Spec folder resolves outside specs/");
  return real;
}

/** Reads one document; null when it does not exist. Symlinked documents are refused. */
export async function readSpecDoc(dir: string, kind: SpecKind, phase: SpecPhase): Promise<string | null> {
  const file = join(dir, phaseFileName(kind, phase));
  const st = await lstatOrNull(file);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) throw new SpecError(403, "ESPECPATH", `${phaseFileName(kind, phase)} must be a regular file`);
  return readFile(file, "utf8");
}

export async function writeSpecDoc(dir: string, kind: SpecKind, phase: SpecPhase, text: string): Promise<void> {
  const file = join(dir, phaseFileName(kind, phase));
  const st = await lstatOrNull(file);
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new SpecError(403, "ESPECPATH", `${phaseFileName(kind, phase)} must be a regular file`);
  await writeFile(file, text, "utf8");
}

export async function listSpecSlugs(projectPath: string): Promise<string[]> {
  const root = await resolveSpecsRoot(projectPath);
  if (!root) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && isValidSpecSlug(e.name)).map((e) => e.name).sort();
}

/** Slug from a title, the same folding as design slugs ("Xuất phiên chat" → "xuat-phien-chat"). */
export function slugFromTitle(title: string): string {
  const slug = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 63).replace(/-+$/, "");
  return isValidSpecSlug(slug) ? slug : "";
}

// ─── PPM-side state ───────────────────────────────────────────────────────────

const stateRoot = (): string => join(getPpmDir(), "specs");

/** Stable per-project folder name: the project path is not a safe file name. */
export function projectKey(projectPath: string): string {
  return createHash("sha256").update(resolve(projectPath)).digest("hex").slice(0, 16);
}

const statePath = (projectPath: string, slug: string): string => join(stateRoot(), projectKey(projectPath), `${slug}.json`);

function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** A spec folder copied in from elsewhere has no state yet: it starts with nothing approved. */
function inferState(slug: string, kind: SpecKind): SpecState {
  return emptySpecState({ slug, title: slug, kind, workflow: "requirements-first", checks: "standard" });
}

export function loadSpecState(projectPath: string, slug: string, fallbackKind: SpecKind = "feature"): SpecState {
  const path = statePath(projectPath, slug);
  if (!existsSync(path)) return inferState(slug, fallbackKind);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SpecState;
    if (parsed?.version !== 1) return inferState(slug, fallbackKind);
    parsed.approvals ??= {};
    parsed.tasks ??= {};
    return parsed;
  } catch {
    return inferState(slug, fallbackKind);
  }
}

export function saveSpecState(projectPath: string, state: SpecState): void {
  mkdirSync(join(stateRoot(), projectKey(projectPath)), { recursive: true });
  state.updatedAt = new Date().toISOString();
  atomicWrite(statePath(projectPath, state.slug), JSON.stringify(state, null, 1));
}

export function hasSpecState(projectPath: string, slug: string): boolean {
  return existsSync(statePath(projectPath, slug));
}

// ─── which chat drives which spec ─────────────────────────────────────────────

export interface SpecSessionBinding {
  projectPath: string;
  slug: string;
  /** Set for a chat PPM started to run one task. */
  taskId?: string;
}

const sessionsPath = (): string => join(stateRoot(), "sessions.json");
let sessions: Record<string, SpecSessionBinding> | null = null;

function loadSessions(): Record<string, SpecSessionBinding> {
  if (sessions) return sessions;
  try {
    sessions = existsSync(sessionsPath()) ? JSON.parse(readFileSync(sessionsPath(), "utf8")) : {};
  } catch {
    sessions = {};
  }
  return sessions!;
}

export function bindSpecSession(sessionId: string, binding: SpecSessionBinding): void {
  const all = loadSessions();
  all[sessionId] = binding;
  mkdirSync(stateRoot(), { recursive: true });
  atomicWrite(sessionsPath(), JSON.stringify(all));
}

export function unbindSpecSession(sessionId: string): void {
  const all = loadSessions();
  if (!(sessionId in all)) return;
  delete all[sessionId];
  atomicWrite(sessionsPath(), JSON.stringify(all));
}

export function specForSession(sessionId: string): SpecSessionBinding | null {
  return loadSessions()[sessionId] ?? null;
}

/** For tests: forget the cached session map so the next read hits the disk. */
export function resetSpecSessionsCache(): void {
  sessions = null;
}

export async function hashFile(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}
