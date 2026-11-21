/**
 * The file index search worker: holds one project's list and searches it (`index-search.ts`),
 * for a list too long to send to a browser. One per project, for the life of the server; a newer
 * build is handed over with `seed` and replaces the list in place. It is never ended and started
 * again per build, because every terminated Bun Worker leaks ~29 MB on Windows (Bun 1.3.12,
 * measured). Walks do not run here: they run in a process of their own
 * (`file-index-walk-process.ts`), whose exit is what returns the walk's memory.
 *
 * It is a second entry point of `bun build --compile`; see `fileIndexWorkerSpec`.
 */
import type { FileEntry } from "../../types/project.ts";
import { buildEntries } from "./index-walk.ts";
import { searchIndex, toSearchable, type SearchableIndex, type SearchKind } from "./index-search.ts";

export type IndexRequest =
  | { type: "search"; id: number; query: string; kind: SearchKind; limit: number }
  /** The list to search from now on: a build's `json` (short enough to send) or `compact`. No reply. */
  | { type: "seed"; json?: Uint8Array<ArrayBuffer>; compact?: Uint8Array<ArrayBuffer> };

export type IndexReply =
  | { id: number; ok: true; files: FileEntry[] }
  | { id: number; ok: false; error: string };

let searchable: SearchableIndex | null = null;

declare const self: Worker;

self.onmessage = (event: MessageEvent<IndexRequest>) => {
  const request = event.data;
  if (request.type === "seed") {
    searchable = null; // let the old list go before the new one is built
    searchable = toSearchable(buildEntries({ json: request.json ?? new Uint8Array(), compact: request.compact }));
    return;
  }
  if (!searchable) {
    self.postMessage({ id: request.id, ok: false, error: "no list held" } satisfies IndexReply);
    return;
  }
  const files = searchIndex(searchable, request.query, request.kind, request.limit);
  self.postMessage({ id: request.id, ok: true, files } satisfies IndexReply);
};
