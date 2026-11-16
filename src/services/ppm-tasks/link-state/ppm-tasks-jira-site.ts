/**
 * A project's Jira site: where its Jira keys open in a browser (`<site>/browse/NX-6284`). From the
 * project's Jira config when it has one (only its base URL is read, never its credentials), else
 * the site of the last Jira issue URL pasted as a link in one of its tasks, kept in the project's
 * settings JSON as `taskJiraSite`. So a project nobody connected to Jira still opens its keys once
 * one issue has been added by its full URL.
 */
import { getDb, patchProjectSettingsJson } from "../../db.service.ts";
import { getConfigByProjectId } from "../../jira-config.service.ts";
import { projectKey as keyOf } from "../../project-name-for-path.ts";
import { jiraSiteUrl } from "../../../shared/ppm-task-link-href.ts";

const SETTINGS_KEY = "taskJiraSite";

interface ProjectRow { id: number; path: string; settings: string | null }

function projectRow(projectKey: string): ProjectRow | null {
  const rows = getDb().query("SELECT id, path, settings FROM projects").all() as ProjectRow[];
  return rows.find((r) => keyOf(r.path) === projectKey) ?? null;
}

function pastedSite(row: ProjectRow): string | null {
  try {
    const value = (JSON.parse(row.settings ?? "{}") as Record<string, unknown>)?.[SETTINGS_KEY];
    return typeof value === "string" ? jiraSiteUrl(value) : null;
  } catch {
    return null;
  }
}

/** The project's Jira site; null when it has neither a Jira config nor a pasted issue URL. */
export function jiraSiteFor(projectKey: string): string | null {
  try {
    const row = projectRow(projectKey);
    if (!row) return null;
    return jiraSiteUrl(getConfigByProjectId(row.id)?.baseUrl) ?? pastedSite(row);
  } catch {
    return null;
  }
}

/**
 * Keeps the site of a pasted Jira issue URL as the project's fallback site (the latest one wins).
 * True when it changed what the project had.
 */
export function rememberPastedJiraSite(projectKey: string, site: string): boolean {
  const clean = jiraSiteUrl(site);
  const row = projectRow(projectKey);
  if (!clean || !row || pastedSite(row) === clean) return false;
  patchProjectSettingsJson(row.path, JSON.stringify({ [SETTINGS_KEY]: clean }));
  return true;
}
