/**
 * Typed client for the host-filesystem routes (`/api/fs/*`).
 *
 * It does not go through `ApiClient` on purpose: that wrapper collapses an error body
 * into `new Error(json.error)` and drops `code`/`hint`, but the explorer's whole error
 * UX is driven by those codes — `EEXIST` opens the collision prompt, `NO_TRASH` offers a
 * permanent delete, `EPROTECTED`/`EDENIED` render the server's remediation hint.
 */

import { getAuthToken } from "./api-client";

export type FsEntryKind = "file" | "directory" | "symlink" | "unknown";

export interface FsEntry {
  name: string;
  path: string;
  /** Coarse type used for sorting and open behaviour. */
  type: "file" | "directory";
  kind: FsEntryKind;
  size?: number;
  modified: string;
}

export interface FsBreadcrumb {
  name: string;
  path: string;
}

export interface FsBrowseResult {
  entries: FsEntry[];
  current: string;
  parent: string | null;
  breadcrumbs: FsBreadcrumb[];
  /** Host path separator — the client never guesses it. */
  sep: string;
  /** True when the directory held more entries than the server's listing cap. */
  truncated?: boolean;
}

export interface FsStatResult {
  path: string;
  name: string;
  kind: FsEntryKind;
  size: number;
  mtime: string;
  ctime: string;
  birthtime: string;
  mode: number;
  readonly: boolean;
  isHidden: boolean;
  target?: string;
  childCount?: number;
  truncated?: boolean;
}

export interface FsDeleteResult {
  removed: string;
  trashed: boolean;
  permanent: boolean;
}

/** A failed `/api/fs` call, carrying the server's machine-readable reason. */
export class FsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "FsError";
  }
}

interface ErrorBody {
  error?: string;
  code?: string;
  hint?: string;
}

async function request<T>(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {},
): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-ppm-client": "web",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers: { ...headers, ...init.headers } });

  let json: { ok?: boolean; data?: T } & ErrorBody;
  try {
    json = await res.json();
  } catch {
    throw new FsError(
      res.ok ? "Empty response from server" : `Server error (HTTP ${res.status})`,
      "EUNKNOWN",
      res.status,
    );
  }

  if (!res.ok || json.ok === false) {
    throw new FsError(
      json.error ?? `HTTP ${res.status}`,
      json.code ?? "EUNKNOWN",
      res.status,
      json.hint,
    );
  }
  return json.data as T;
}

const body = (value: unknown) => JSON.stringify(value);
const q = encodeURIComponent;

export const fsApi = {
  browse(path: string, opts: { showHidden?: boolean; signal?: AbortSignal } = {}) {
    const hidden = opts.showHidden ? "&showHidden=true" : "";
    return request<FsBrowseResult>(`/api/fs/browse?path=${q(path)}${hidden}`, {
      signal: opts.signal,
    });
  },

  stat(path: string, signal?: AbortSignal) {
    return request<FsStatResult>(`/api/fs/stat?path=${q(path)}`, { signal });
  },

  /** `destination` is the full target path, not the containing directory. */
  copy(source: string, destination: string) {
    return request<{ source: string; destination: string }>("/api/fs/copy", {
      method: "POST",
      body: body({ source, destination }),
    });
  },

  move(source: string, destination: string) {
    return request<{ source: string; destination: string; crossDevice: boolean }>("/api/fs/move", {
      method: "POST",
      body: body({ source, destination }),
    });
  },

  /** `newName` is a bare name — the server rejects anything containing a separator. */
  rename(path: string, newName: string) {
    return request<{ from: string; to: string }>("/api/fs/rename", {
      method: "POST",
      body: body({ path, newName }),
    });
  },

  touch(path: string) {
    return request<{ path: string }>("/api/fs/touch", {
      method: "POST",
      body: body({ path }),
    });
  },

  /** `gitInit` defaults to true server-side; the explorer never wants that. */
  mkdir(path: string, gitInit = false) {
    return request<{ path: string; gitInitialized: boolean }>("/api/fs/mkdir", {
      method: "POST",
      body: body({ path, gitInit }),
    });
  },

  /** Moves to the OS trash unless `permanent` is set. */
  remove(path: string, permanent = false) {
    return request<FsDeleteResult>("/api/fs/delete", {
      method: "DELETE",
      body: body({ path, permanent }),
    });
  },

  /** Single-use, path-bound download URL. The token is spent by the first request. */
  async downloadUrl(path: string): Promise<string> {
    const { token } = await request<{ token: string }>("/api/fs/download/token", {
      method: "POST",
      body: body({ path }),
    });
    return `/api/fs/raw?path=${q(path)}&download=true&dl_token=${q(token)}`;
  },

  /**
   * Target for a streamed `PUT` upload — `path` is the full destination file path. Not used
   * through `request()`: the upload helper needs `XMLHttpRequest` for progress events, which
   * `fetch` cannot give.
   */
  uploadUrl(path: string, overwrite: boolean): string {
    return `/api/fs/upload?path=${q(path)}&overwrite=${overwrite ? "1" : "0"}`;
  },
};
