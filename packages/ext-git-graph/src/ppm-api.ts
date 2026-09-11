/**
 * Thin client for the PPM HTTP API, used to map a project path to the project
 * name that `window.openTab` needs. Initialised once from `activate`.
 */
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

/** Resolve project name from path via PPM API */
export async function resolveProjectName(projectPath: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/api/projects`, authHeaders());
    const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
    if (json.ok && json.data) {
      const match = json.data.find((p) => p.path === projectPath);
      if (match) return match.name;
    }
  } catch {}
  // Fallback to directory name
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || "project";
}
