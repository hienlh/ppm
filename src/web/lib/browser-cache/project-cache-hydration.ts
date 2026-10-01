/**
 * Registry of per-project cache hydrators (slash items in
 * `slash-items-cache.ts`, recent sessions and tags in `session-list-store.ts`)
 * plus the dedupe that keeps one project's hydrators from re-running on every
 * panel switch back to it.
 */
import { projectCacheId, type ProjectCacheRef } from "./cache-keys";

export type ProjectHydrator = (project: ProjectCacheRef) => Promise<void>;

const hydrators = new Set<ProjectHydrator>();

/** Projects whose hydrators have already been started, keyed by
 * `projectCacheId`. Cleared by `wipe-browser-caches.ts` so a wipe forces a
 * fresh hydration next time. */
const started = new Map<string, ProjectCacheRef>();

function runHydrator(fn: ProjectHydrator, project: ProjectCacheRef): Promise<void> {
  return fn(project).catch((err) => {
    console.warn("[browser-cache] project hydrator failed", err);
  });
}

/** Register a hydrator to run on every `hydrateProjectCache` call that is not
 * deduped. Hydrators run in parallel and must not depend on each other.
 *
 * A hydrator can register after its project was already hydrated: modules that
 * live in a lazy chunk (the chat tab's slash cache) load only once the tab
 * mounts, long after boot started hydration. It is run for those projects on
 * registration, or the cache it owns would never be read back after a reload. */
export function registerProjectHydrator(fn: ProjectHydrator): void {
  if (hydrators.has(fn)) return;
  hydrators.add(fn);
  for (const project of started.values()) void runHydrator(fn, project);
}

/**
 * Runs every registered hydrator for `project`, once per `projectCacheId`.
 * Safe to call on every project switch — a project switched back to does not
 * re-fetch until the cache is wiped. Never throws: one hydrator failing must
 * not block the others or the caller.
 */
export function hydrateProjectCache(project: ProjectCacheRef): Promise<void> {
  rememberLastProject(project);
  const id = projectCacheId(project);
  if (started.has(id)) return Promise.resolve();
  started.set(id, project);
  return Promise.all([...hydrators].map((fn) => runHydrator(fn, project))).then(() => undefined);
}

/** Clears the dedupe so the next `hydrateProjectCache` call re-runs every
 * hydrator for every project. Called by a full wipe. */
export function resetHydrationDedupe(): void {
  started.clear();
}

/** Drops one project's dedupe entry, e.g. after its cache keys were evicted
 * on rename/delete — the retired id has nothing left to dedupe against. */
export function forgetProjectHydration(projectId: string): void {
  started.delete(projectId);
}

// ---------------------------------------------------------------------------
// Last-active-project pointer
// ---------------------------------------------------------------------------
// `hydrateProjectCache` needs a project's `path`, which app boot does not yet
// have when it wants to start hydration — that happens before `fetchProjects()`
// resolves. This tiny pointer, written every time hydration actually runs,
// lets the next page load warm the cache for the project it last had open
// without waiting on the network first. A first-ever visit simply has none.

/** Holds a project name and its absolute path, so a token drop wipes it
 * along with the rest of the cache (`wipe-browser-caches.ts`). */
export const LAST_PROJECT_REF_KEY = "ppm-last-project-ref";

function rememberLastProject(project: ProjectCacheRef): void {
  try {
    localStorage.setItem(LAST_PROJECT_REF_KEY, JSON.stringify(project));
  } catch {
    // Storage blocked or unavailable — nothing to remember.
  }
}

/** The project `hydrateProjectCache` last ran for, from a previous page
 * load. Returns null on a first-ever visit or when storage is blocked. */
export function peekLastProjectRef(): ProjectCacheRef | null {
  try {
    const raw = localStorage.getItem(LAST_PROJECT_REF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ProjectCacheRef>;
    if (typeof parsed.name === "string" && typeof parsed.path === "string") {
      return { name: parsed.name, path: parsed.path };
    }
    return null;
  } catch {
    return null;
  }
}
