/**
 * The Git Graph's way into PPM's own git API.
 *
 * The working tree, the staged blocks and the commit message the graph shows
 * are the ones Source Control and the Review tab show, so they are read from the
 * same routes rather than parsed again from `git status` here. Two surfaces
 * reading one repository two ways disagree sooner or later — about a rename,
 * about a conflict, about which message is being written — and every write the
 * graph makes through these routes is also what tells the other surfaces to
 * look again (`git:changed`).
 *
 * A panel is opened on a repository, which for a container workspace is a
 * folder *inside* the project, so the project is resolved by containment and
 * the repository rides along as `?repo=` — omitted when it is the project root,
 * as every other git surface does.
 */
import { authHeaders, getBaseUrl } from "./ppm-api.ts";
import { pickProject, type ProjectRef } from "./project-scope.ts";

export interface PpmRepo {
  projectName: string;
  /** Absolute repository path, or null when the repository is the project root. */
  repo: string | null;
}

function normalizeDir(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** The `?repo=` value for a repository inside a project: null when it is the project itself. */
export function repoParam(projectPath: string, gitRoot: string): string | null {
  return normalizeDir(projectPath) === normalizeDir(gitRoot) ? null : gitRoot;
}

/** A git route's URL. `path` starts with a slash: `/changes`, `/stash/apply`. */
export function gitRouteUrl(base: string, ref: PpmRepo, path: string): string {
  const url = `${base}/api/project/${encodeURIComponent(ref.projectName)}/git${path}`;
  return ref.repo ? `${url}?repo=${encodeURIComponent(ref.repo)}` : url;
}

/**
 * Which project a repository belongs to, or null when PPM does not know it.
 *
 * No basename fallback, unlike `resolveProject`: a guessed name builds URLs for
 * a project that does not exist, and every one of them would 404 into an error
 * that names the wrong cause.
 */
export function ppmRepoFor(projects: ProjectRef[], gitRoot: string): PpmRepo | null {
  const project = pickProject(projects, gitRoot);
  return project ? { projectName: project.name, repo: repoParam(project.path, gitRoot) } : null;
}

/**
 * One lookup per panel, kept only once it succeeded — a server that was
 * restarting, or a project added a moment later, is asked again next time
 * instead of being remembered as "no such project" for the panel's life.
 */
export function createPpmRepoResolver(gitRoot: string): () => Promise<PpmRepo> {
  let pending: Promise<PpmRepo> | null = null;
  return () => {
    if (!pending) {
      pending = (async () => {
        const res = await fetch(`${getBaseUrl()}/api/projects`, authHeaders());
        const json = await res.json() as { ok?: boolean; data?: ProjectRef[]; error?: string };
        if (!json.ok || !json.data) throw new Error(json.error || `PPM answered ${res.status}`);
        const ref = ppmRepoFor(json.data, gitRoot);
        if (!ref) throw new Error("This repository is not inside a PPM project.");
        return ref;
      })();
      pending.catch(() => { pending = null; });
    }
    return pending;
  };
}

/** Call one git route; the `data` of PPM's envelope, or the error it gave. */
export async function ppmGit<T>(
  ref: PpmRepo,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = authHeaders() as { headers?: Record<string, string> };
  const res = await fetch(gitRouteUrl(getBaseUrl(), ref, path), {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(auth.headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: { ok?: boolean; data?: T; error?: string } | null = null;
  try {
    json = await res.json() as { ok?: boolean; data?: T; error?: string };
  } catch { /* not JSON: reported by status below */ }
  if (!res.ok || !json?.ok) throw new Error(json?.error || `PPM answered ${res.status}`);
  return json.data as T;
}

export interface RemoteWeb {
  /** `https://host/owner/repo` */
  base: string;
  /** What goes between `base` and a commit hash. */
  commitPath: string;
  /** "GitHub", "GitLab", "Bitbucket", or "remote" for any other host. */
  label: string;
}

/**
 * Where a remote's commits can be opened in a browser, or null when the remote
 * is not a URL a browser can open (a local path, `file://`, an unknown scheme).
 *
 * `git@host:owner/repo.git`, `ssh://git@host/owner/repo.git` and
 * `https://user@host/owner/repo.git` all name the same page; credentials in an
 * https remote are dropped rather than handed to a browser tab.
 */
export function remoteWeb(remoteUrl: string): RemoteWeb | null {
  const base = remoteWebBase(remoteUrl);
  if (!base) return null;
  const host = new URL(base).hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) return { base, commitPath: "/commit/", label: "GitHub" };
  if (host.includes("gitlab")) return { base, commitPath: "/-/commit/", label: "GitLab" };
  if (host.includes("bitbucket")) return { base, commitPath: "/commits/", label: "Bitbucket" };
  return { base, commitPath: "/commit/", label: "remote" };
}

/** `https://host/owner/repo` for a remote URL, or null. Exported for its test. */
export function remoteWebBase(remoteUrl: string): string | null {
  const raw = remoteUrl.trim();
  // An http(s) remote is a web address already, port and scheme included; an
  // ssh one names the host's web page only by its host name.
  let origin: string;
  let path: string;
  const scp = raw.match(/^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/);
  if (/^(https?|ssh|git):\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (!parsed.hostname) return null;
    origin = /^https?:$/.test(parsed.protocol) ? `${parsed.protocol}//${parsed.host}` : `https://${parsed.hostname}`;
    path = parsed.pathname;
  } else if (scp) {
    origin = `https://${scp[1]}`;
    path = `/${scp[2]}`;
  } else {
    return null;
  }
  path = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!/^\/[^/]+\/.+/.test(path)) return null;
  return `${origin}${path}`;
}
