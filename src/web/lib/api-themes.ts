import { getAuthToken } from "@/lib/api-client";
import type { PpmTheme } from "@/theme/types";

/** HTTP client for imported-theme management (/api/settings/themes). */

function authHeaders(json = false): HeadersInit {
  const token = getAuthToken();
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function unwrap<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body.data as T;
}

export async function fetchImportedThemes(): Promise<PpmTheme[]> {
  const res = await fetch("/api/settings/themes", { headers: authHeaders() });
  return unwrap<PpmTheme[]>(res);
}

export interface ImportThemeRequest {
  source: "json" | "url" | "vsix" | "upload";
  value: string;
  name?: string;
}

export async function importTheme(req: ImportThemeRequest): Promise<PpmTheme[]> {
  const res = await fetch("/api/settings/themes", {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(req),
  });
  const data = await unwrap<{ themes: PpmTheme[] }>(res);
  return data.themes;
}

export async function deleteImportedTheme(id: string): Promise<void> {
  const res = await fetch(`/api/settings/themes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  await unwrap(res);
}

export async function renameImportedTheme(id: string, name: string): Promise<PpmTheme> {
  const res = await fetch(`/api/settings/themes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders(true),
    body: JSON.stringify({ name }),
  });
  return unwrap<PpmTheme>(res);
}
