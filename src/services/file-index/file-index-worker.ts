/**
 * The file index worker: walks a project, serialises and gzips the list, on a thread of its own.
 *
 * On the main thread the walk of nxsys-workspace (181k entries) cost ~7 s of the event loop in
 * 10 ms slices, and serialising and gzipping each download another ~120 ms — time every request,
 * chat stream and terminal waited behind. Here none of it touches the thread that serves them.
 * The results cross back as transferred buffers, so the main thread copies nothing either.
 *
 * It also keeps the lists too long to send to a browser, and searches them (`index-search.ts`).
 *
 * It is a second entry point of `bun build --compile`; see `fileIndexWorkerSpec`.
 */
import { REMOTE_FILE_SEARCH_FROM_ENTRIES } from "../../shared/file-index-limits.ts";
import type { FileEntry } from "../../types/project.ts";
import { serializeIndex, walkIndex, type IndexBuild, type IndexFilter } from "./index-walk.ts";
import { searchIndex, toSearchable, type SearchableIndex, type SearchKind } from "./index-search.ts";

export type IndexRequest =
  | { type: "walk"; id: number; rootPath: string; filter: IndexFilter }
  | { type: "search"; id: number; rootPath: string; query: string; kind: SearchKind; limit: number }
  /** Hand over a list to search, for a project this thread does not hold one of. No reply. */
  | { type: "seed"; rootPath: string; json: Uint8Array };

export type IndexReply =
  /** `searchable`: whether this thread now holds the walked list, ready to search. */
  | { id: number; ok: true; build: IndexBuild; searchable: boolean }
  | { id: number; ok: true; files: FileEntry[] }
  | { id: number; ok: false; error: string };

/**
 * Entries between two hand-backs of this thread. Nothing here waits on a timer or a socket, so a
 * slice only has to be short enough for a search to be answered between two of them: 512 entries
 * are ~18 ms on nxsys-workspace, at ~0.4 s added to its ~6.3 s walk for the yields.
 */
const ENTRIES_PER_SLICE = 512;

/** The lists this thread searches, by project root. */
const searchable = new Map<string, SearchableIndex>();

declare const self: Worker;

self.onmessage = async (event: MessageEvent<IndexRequest>) => {
  const request = event.data;
  if (request.type === "seed") {
    const entries = JSON.parse(new TextDecoder().decode(request.json)).data as FileEntry[];
    searchable.set(request.rootPath, toSearchable(entries));
    return;
  }
  if (request.type === "search") {
    const index = searchable.get(request.rootPath);
    if (!index) {
      self.postMessage({ id: request.id, ok: false, error: "no list held for this project" } satisfies IndexReply);
      return;
    }
    const files = searchIndex(index, request.query, request.kind, request.limit);
    self.postMessage({ id: request.id, ok: true, files } satisfies IndexReply);
    return;
  }
  const { id, rootPath, filter } = request;
  try {
    const started = performance.now();
    const entries = await walkIndex(rootPath, filter, ENTRIES_PER_SLICE);
    const { json, hash } = serializeIndex(entries);
    const gzip = Bun.gzipSync(json);
    const build: IndexBuild = { json, gzip, hash, count: entries.length, walkMs: performance.now() - started };
    // A list short enough to send is searched in the browser, unless it was searched here before.
    const keep = entries.length >= REMOTE_FILE_SEARCH_FROM_ENTRIES || searchable.has(rootPath);
    if (keep) searchable.set(rootPath, toSearchable(entries));
    self.postMessage({ id, ok: true, build, searchable: keep } satisfies IndexReply, [json.buffer, gzip.buffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, error: (e as Error).message } satisfies IndexReply);
  }
};
