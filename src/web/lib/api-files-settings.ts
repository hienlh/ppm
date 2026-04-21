/**
 * api-files-settings.ts
 * API client for global file filter settings and per-project file filter overrides.
 */

import { api } from "./api-client";

/** Typed file filter config — mirrors server-side FileFilterConfig */
export interface FileFilterSettings {
  filesExclude: string[];
  searchExclude: string[];
  useIgnoreFiles: boolean;
}

/** Per-project settings envelope — only files field used here */
export interface ProjectFileSettings {
  files?: Partial<FileFilterSettings>;
}

// ── Global settings ──────────────────────────────────────────────────────────

/** GET /api/settings/files — returns global file filter config */
export function getFilesSettings(): Promise<FileFilterSettings> {
  return api.get<FileFilterSettings>("/api/settings/files");
}

/** PATCH /api/settings/files — partial update to global file filter config */
export function updateFilesSettings(patch: Partial<FileFilterSettings>): Promise<FileFilterSettings> {
  return api.patch<FileFilterSettings>("/api/settings/files", patch);
}

// ── Per-project settings ─────────────────────────────────────────────────────

/** GET /api/projects/:name/settings — returns per-project settings (ProjectSettings shape) */
export function getProjectSettings(projectName: string): Promise<ProjectFileSettings> {
  return api.get<ProjectFileSettings>(`/api/projects/${encodeURIComponent(projectName)}/settings`);
}

/** PATCH /api/projects/:name/settings — merges patch into project settings */
export function updateProjectSettings(projectName: string, patch: ProjectFileSettings): Promise<ProjectFileSettings> {
  return api.patch<ProjectFileSettings>(`/api/projects/${encodeURIComponent(projectName)}/settings`, patch);
}
