/**
 * Cache keys for the browser-side project cache.
 *
 * Every project-scoped key is built from a hash of the project's name AND
 * path, never the name alone: a rename orphans the old key instead of
 * colliding with it, and a new project that reuses an old name does not
 * inherit its predecessor's cache. See `project-cache-hydration.ts` and
 * `wipe-browser-caches.ts` for where those old keys get evicted.
 */

/** The minimal project shape every builder here needs. A call site that only
 * has a project name (most do — see `use-*` hooks and store actions) must
 * look up its `path` first, e.g. from `useProjectStore.getState().projects`. */
export interface ProjectCacheRef {
  name: string;
  path: string;
}

/** FNV-1a, 32-bit, hex-encoded. Not cryptographic — it only needs to be
 * short, stable across reloads, and collision-unlikely for the handful of
 * projects one browser has open at a time. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Short stable id for a project. `\0` cannot appear in a name or a
 * filesystem path, so it safely separates the two fields being hashed. */
export function projectCacheId(project: ProjectCacheRef): string {
  return fnv1a(`${project.name}\0${project.path}`);
}

/** IndexedDB key for one provider's cached slash-command list. */
export function slash(projectId: string, provider: string): string {
  return `${projectId}:slash:${provider}`;
}

/** IndexedDB key for a project's cached recent-session list. */
export function sessions(projectId: string): string {
  return `${projectId}:sessions`;
}

/** IndexedDB key for a project's cached tag list. */
export function tags(projectId: string): string {
  return `${projectId}:tags`;
}

/** Every project's cached chat-provider list is a localStorage entry under
 * this shared prefix, so a full wipe can remove them all without knowing
 * which projects exist. */
export const CHAT_PROVIDERS_KEY_PREFIX = "ppm-chat-providers:";

/** localStorage key for a project's cached chat provider list. */
export function providers(projectId: string): string {
  return `${CHAT_PROVIDERS_KEY_PREFIX}${projectId}`;
}
