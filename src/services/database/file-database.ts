/**
 * A SQLite file opened from the editor or a file explorer rather than saved as a connection. It
 * is served by the same `/api/db/connections/…` routes as a saved one, under the id `file`, with
 * the file named on every request (`?path=` and, for a file inside a project, `?project=`) and
 * checked again each time — nothing is saved and nothing is remembered between requests.
 *
 * Two doors, as before the tabs were merged:
 *
 * - a path relative to a project must stay inside that project;
 * - an absolute path with no project is anywhere on the disk the filesystem routes may reach
 *   (UNC shares are not), and SQL typed against it returns at most `FILE_DATABASE_MAX_ROWS`
 *   rows: such a file can be any size, and is not the user's own project data.
 *
 * Both refuse the PPM directory, following symlinks: it holds the database with every
 * connection's credentials and the auth token.
 */
import { stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { configService } from "../config.service.ts";
import { assertAllowed, assertNotPpmSubtreeDeep, resolvePath } from "../fs-path-guard.service.ts";
import type { ConnectionRow } from "../db.service.ts";
import type { DbConnectionConfig } from "../../types/database.ts";

/** The `:id` a database file goes by in `/api/db/connections/:id/…`. */
export const FILE_CONNECTION_ID = "file";

/** Rows SQL typed against a file outside every project may return. */
export const FILE_DATABASE_MAX_ROWS = 1_000;

export interface FileDatabase {
  /** Absolute and resolved. */
  path: string;
  /** The project the path was given relative to; null for a file reached by absolute path. */
  project: string | null;
}

/** A database file dressed as a connection row, so the routes serve it like a saved one. */
export interface FileConnectionRow extends ConnectionRow {
  file: FileDatabase;
}

function refusal(message: string, status: number, code: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Check a database file named by a request and resolve it. Throws an error carrying `status` and
 * `code` (for `fsErrorBody`): 400 for a missing or non-file path, 403 for one out of bounds, 404
 * for a file or project that does not exist. The file is only ever stat'ed here — never created.
 */
export async function openFileDatabase(input: { path?: string | null; project?: string | null }): Promise<FileDatabase> {
  const path = input.path?.trim();
  if (!path) throw refusal("Missing query parameter: path", 400, "EINVAL");
  const projectName = input.project?.trim() || null;

  let resolved: string;
  if (projectName !== null) {
    const project = configService.get("projects").find((p) => p.name === projectName);
    if (!project) throw refusal(`Project not found: ${projectName}`, 404, "ENOENT");
    const root = resolve(project.path);
    resolved = resolve(root, path);
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw refusal("Access denied: path outside project", 403, "EDENIED");
  } else {
    // A relative path would resolve against the server's own working directory.
    if (!isAbsolute(path) && !/^~(?:[/\\]|$)/.test(path)) throw refusal("A database file outside a project needs an absolute path", 400, "EINVAL");
    resolved = resolvePath(path);
    assertAllowed(resolved);
  }
  await assertNotPpmSubtreeDeep(resolved);
  const info = await stat(resolved);
  if (!info.isFile()) throw refusal("Not a database file", 400, "EINVAL");
  return { path: resolved, project: projectName };
}

export function fileConnectionRow(file: FileDatabase): FileConnectionRow {
  return {
    id: 0,
    type: "sqlite",
    name: basename(file.path),
    connection_config: "",
    group_name: null,
    color: null,
    readonly: 0,
    ai_access: 0,
    sort_order: 0,
    created_at: "",
    updated_at: "",
    file,
  };
}

export function isFileConnection(conn: ConnectionRow): conn is FileConnectionRow {
  return (conn as Partial<FileConnectionRow>).file !== undefined;
}

/** The adapter config of a database file: writable, as the viewer it replaces was, and capped outside a project. */
export function fileConnectionConfig(conn: FileConnectionRow): DbConnectionConfig {
  return {
    type: "sqlite",
    path: conn.file.path,
    readonly: false,
    ...(conn.file.project === null ? { maxQueryRows: FILE_DATABASE_MAX_ROWS } : {}),
  };
}
