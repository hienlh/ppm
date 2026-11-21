/**
 * The file index worker. One instance does one of two jobs, and the runner ends it afterwards:
 *
 * - a walk: walk a project, serialise (and for a list short enough to send, gzip) the result, hand
 *   it back as transferred buffers, and be terminated. The walk leaves this thread's heap holding
 *   far more than the list itself — 1.17M entries left a long-lived worker at 1-3 GB that it never
 *   gave back, the "native" memory the server's diagnostics kept reporting — and terminating the
 *   worker is what returns it (2.5 GB → 0.8 GB, measured).
 * - searching one build of one project (`index-search.ts`), handed over with `seed`, until the
 *   runner retires it for a newer build. Built from the list alone, it holds about the list.
 *
 * On the main thread the walk of nxsys-workspace (181k entries) cost ~7 s of the event loop in
 * 10 ms slices; here none of it touches the thread that serves requests.
 *
 * It is a second entry point of `bun build --compile`; see `fileIndexWorkerSpec`.
 */
import type { FileEntry } from "../../types/project.ts";
import { buildEntries, prepareBuild, walkIndex, type IndexBuild, type IndexFilter } from "./index-walk.ts";
import { searchIndex, toSearchable, type SearchableIndex, type SearchKind } from "./index-search.ts";

export type IndexRequest =
  | { type: "walk"; id: number; rootPath: string; filter: IndexFilter }
  | { type: "search"; id: number; query: string; kind: SearchKind; limit: number }
  /** The build this worker searches: its `json` (a list short enough to send) or `compact`. No reply. */
  | { type: "seed"; json?: Uint8Array; compact?: Uint8Array };

export type IndexReply =
  | { id: number; ok: true; build: IndexBuild }
  | { id: number; ok: true; files: FileEntry[] }
  | { id: number; ok: false; error: string };

/**
 * Entries between two hand-backs of this thread. Nothing here waits on a timer or a socket, so a
 * slice only has to be short; 512 entries are ~18 ms on nxsys-workspace.
 */
const ENTRIES_PER_SLICE = 512;

/** The list this worker searches, once seeded. */
let searchable: SearchableIndex | null = null;

declare const self: Worker;

self.onmessage = async (event: MessageEvent<IndexRequest>) => {
  const request = event.data;
  if (request.type === "seed") {
    searchable = toSearchable(buildEntries({ json: (request.json ?? new Uint8Array()) as Uint8Array<ArrayBuffer>, compact: request.compact as Uint8Array<ArrayBuffer> | undefined }));
    return;
  }
  if (request.type === "search") {
    if (!searchable) {
      self.postMessage({ id: request.id, ok: false, error: "no list held" } satisfies IndexReply);
      return;
    }
    const files = searchIndex(searchable, request.query, request.kind, request.limit);
    self.postMessage({ id: request.id, ok: true, files } satisfies IndexReply);
    return;
  }
  const { id, rootPath, filter } = request;
  try {
    const started = performance.now();
    const { entries, truncated } = await walkIndex(rootPath, filter, ENTRIES_PER_SLICE);
    const prepared = prepareBuild(entries, truncated);
    const gzip = prepared.large ? new Uint8Array() : Bun.gzipSync(prepared.json);
    const build: IndexBuild = { ...prepared, gzip, walkMs: performance.now() - started };
    const transfer = [build.json.buffer, gzip.buffer, ...(build.compact ? [build.compact.buffer] : [])];
    self.postMessage({ id, ok: true, build } satisfies IndexReply, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: (e as Error).message } satisfies IndexReply);
  }
};
