/**
 * Thin client for the PPM HTTP API, used to map a project path to the project
 * name that `window.openTab` needs. Initialised once from `activate`.
 */
import { pickProject, toProjectRelative, type ProjectRef } from "./project-scope.ts";
let baseUrl = "";
let authToken = "";

export function initPpmApi(): void {
  baseUrl = (globalThis as any).__PPM_BASE_URL__ || "";
  authToken = (globalThis as any).__PPM_AUTH_TOKEN__ || "";
}

/** Build fetch options with auth header when token is available */
export function authHeaders(): RequestInit {
  return authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {};
}

export function getBaseUrl(): string {
  return baseUrl;
}

/** Resolve project path from PPM API as fallback */
export async function resolveProjectPath(): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/projects`, authHeaders());
    const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
    if (!json.ok || !json.data || json.data.length === 0) return null;
    // Single project — safe to auto-select
    if (json.data.length === 1) return json.data[0]?.path ?? null;
    // Multiple projects — cannot guess which is active, return null
    return null;
  } catch {}
  return null;
}

/**
 * Resolve the registered project owning `dirPath` via the PPM API.
 *
 * `dirPath` is the panel's git root, which for a container workspace is a
 * *subfolder* of the project — so an exact match is not enough. The basename
 * fallback is kept for the case where the API cannot be reached at all, but it
 * is a guess: it names no registered project, so anything built from it will
 * 404.
 */
export async function resolveProject(dirPath: string): Promise<ProjectRef> {
  try {
    const res = await fetch(`${baseUrl}/api/projects`, authHeaders());
    const json = await res.json() as { ok: boolean; data?: ProjectRef[] };
    if (json.ok && json.data) {
      const match = pickProject(json.data, dirPath);
      if (match) return match;
    }
  } catch {}
  // Fallback to directory name
  return { name: dirPath.split(/[\\/]/).filter(Boolean).pop() || "project", path: dirPath };
}

/** Resolve project name from path via PPM API */
export async function resolveProjectName(dirPath: string): Promise<string> {
  return (await resolveProject(dirPath)).name;
}

/**
 * What a tab needs to open a file git named: the project it belongs to, and the
 * path expressed relative to *that* rather than to the repository git ran in.
 *
 * Both come from one lookup on purpose — the name and the rebasing depend on
 * the same answer, and resolving them separately is how one of them gets
 * forgotten.
 */
export async function resolveFileTab(
  gitRoot: string,
  filePath: string,
): Promise<{ projectName: string; filePath: string }> {
  const project = await resolveProject(gitRoot);
  return {
    projectName: project.name,
    filePath: toProjectRelative(project.path, gitRoot, filePath),
  };
}
