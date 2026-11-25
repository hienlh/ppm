/**
 * Turns a project's search state (`search-store.ts`) into requests.
 *
 * - `schedule` debounces typing — the query, and while the replace field is open the replace
 *   text too, since the server computes each match's replacement.
 * - Every search has its own AbortController, and the project's older search is aborted before a
 *   newer one goes out, so the server stops it (1.5) and its answer never lands.
 * - `replace` posts the listed matches to `POST /files/replace`.
 *
 * Plain `fetch` rather than `api.get`: `api.get` gives up when headers take 30 s, which is exactly
 * how long the search host may legitimately take before answering (`TIME_LIMIT_MS`). Bodies are
 * read with or without the `{ ok, data }` envelope, since the search host hands back bytes the
 * route does not re-wrap.
 */
import { ApiError, getAuthToken, projectUrl } from "../api-client";
import { getSearchState, useSearchStore, type SearchErrorInfo, type SearchState } from "../../stores/search-store";
import type { ReplaceReport, ReplaceRequest, SearchResponse } from "../../../services/content-search/search-options";

export const SEARCH_DEBOUNCE_MS = 300;

/** The `GET /files/search` URL for this state, or null when there is nothing to search. */
export function searchUrl(project: string, state: SearchState): string | null {
  if (state.query === "") return null;
  const p = new URLSearchParams({
    q: state.query,
    caseSensitive: String(state.caseSensitive),
    wholeWord: String(state.wholeWord),
    regex: String(state.regex),
  });
  if (state.include.trim()) p.set("include", state.include.trim());
  if (state.exclude.trim()) p.set("exclude", state.exclude.trim());
  p.set("useIgnore", String(state.useIgnore));
  if (state.showReplace) {
    // An empty replace text in an open field is still a replacement: it deletes the matches.
    p.set("replace", state.replace);
    p.set("preserveCase", String(state.preserveCase));
  }
  return `${projectUrl(project)}/files/search?${p}`;
}

export interface SearchClient {
  /** Search after the debounce, aborting whatever this project had running or pending. */
  schedule(project: string): void;
  /** Search at once (Refresh, Retry, Enter). */
  searchNow(project: string): Promise<void>;
  /** Stop this project's pending or running search. */
  cancel(project: string): void;
  /** Empty search that starts the server's search host before the first real query. */
  warmUp(project: string): void;
  replace(project: string, files: ReplaceRequest["files"]): Promise<ReplaceReport>;
}

export interface SearchClientOptions {
  fetch?: typeof fetch;
  debounceMs?: number;
}

function headers(json: boolean): Headers {
  const h = new Headers({ "x-ppm-client": "web" });
  if (json) h.set("Content-Type", "application/json");
  const token = getAuthToken();
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

/** The body as `T`, with or without the envelope; a refusal is thrown as `ApiError`. */
async function readBody<T>(res: Response): Promise<T> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    if (res.ok) throw new ApiError("Empty response from server", res.status, null);
  }
  const body = json as { ok?: unknown; data?: unknown; error?: unknown } | null;
  if (!res.ok || body?.ok === false) {
    const message = typeof body?.error === "string" ? body.error : `Server error (HTTP ${res.status})`;
    throw new ApiError(message, res.status, json);
  }
  return (body?.ok === true && "data" in body ? body.data : json) as T;
}

function errorInfo(error: unknown): SearchErrorInfo {
  if (error instanceof ApiError) return { message: error.message, status: error.status };
  return { message: error instanceof Error ? error.message : String(error), status: 0 };
}

export function createSearchClient(options: SearchClientOptions = {}): SearchClient {
  // Read the global at call time, so a page (or test) that replaces `fetch` later is honoured.
  const doFetch: (url: string, init: RequestInit) => Promise<Response> =
    options.fetch ?? ((url, init) => fetch(url, init));
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Map<string, AbortController>();
  const update = (project: string, patch: Partial<SearchState>) => useSearchStore.getState().update(project, patch);

  function stop(project: string): void {
    const timer = timers.get(project);
    if (timer) clearTimeout(timer);
    timers.delete(project);
    running.get(project)?.abort();
    running.delete(project);
  }

  function showNothing(project: string): void {
    update(project, { response: null, status: "idle", error: null, dismissed: new Set(), collapsed: new Set(), focusedRow: null });
  }

  async function searchNow(project: string): Promise<void> {
    stop(project);
    const state = getSearchState(project);
    const url = searchUrl(project, state);
    if (!url) return showNothing(project);

    const controller = new AbortController();
    running.set(project, controller);
    update(project, { status: "searching", error: null });
    try {
      const res = await doFetch(url, { headers: headers(false), signal: controller.signal });
      const response = await readBody<SearchResponse>(res);
      if (running.get(project) !== controller) return;
      running.delete(project);
      update(project, {
        response,
        status: "done",
        error: null,
        dismissed: new Set(),
        collapsed: new Set(),
        focusedRow: null,
      });
      useSearchStore.getState().addToHistory(project, state.query);
    } catch (error) {
      // Aborted, or replaced by a newer search: that one owns the state now.
      if (running.get(project) !== controller) return;
      running.delete(project);
      update(project, { response: null, status: "error", error: errorInfo(error) });
    }
  }

  return {
    searchNow,

    schedule(project) {
      stop(project);
      if (!searchUrl(project, getSearchState(project))) return showNothing(project);
      update(project, { status: "searching", error: null });
      timers.set(project, setTimeout(() => {
        timers.delete(project);
        void searchNow(project);
      }, debounceMs));
    },

    cancel(project) {
      stop(project);
      if (getSearchState(project).status === "searching") update(project, { status: "idle" });
    },

    warmUp(project) {
      doFetch(`${projectUrl(project)}/files/search?q=`, { headers: headers(false) })
        .then((res) => res.body?.cancel())
        .catch(() => {});
    },

    async replace(project, files) {
      const res = await doFetch(`${projectUrl(project)}/files/replace`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ files }),
      });
      return readBody<ReplaceReport>(res);
    },
  };
}

export const searchClient = createSearchClient();
