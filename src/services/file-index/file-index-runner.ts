/**
 * Runs index walks on the file index worker, or on this thread when no worker can run.
 *
 * A compiled build only has a worker that is one of its entry points (the `build` script,
 * `scripts/release.sh` and the release workflow all name it, and release-compile-entries.test.ts
 * keeps them agreeing), and there a worker that cannot load fails with an error event after it
 * was constructed, not with a throw.
 * So every walk it was given is re-run here: a missing worker costs the event loop the walk,
 * which is where every walk ran before, and never costs a caller its answer.
 */
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { isCompiledBinary } from "../autostart-generator.ts";
import type { FileEntry } from "../../types/project.ts";
import { serializeIndex, walkIndex, type IndexBuild, type IndexFilter } from "./index-walk.ts";
import { searchIndex, toSearchable, type SearchableIndex, type SearchKind } from "./index-search.ts";
import type { IndexReply, IndexRequest } from "./file-index-worker.ts";

const gzipAsync = promisify(gzip);

/**
 * Entries per slice when walking on this thread. An entry costs a few glob tests and two gitignore
 * checks — ~34 µs on nxsys-workspace — so a slice is about 10 ms, which is as long as a health
 * probe or a chat stream waits. Counted rather than timed so that how often it yields does not
 * depend on the machine.
 */
const MAIN_THREAD_ENTRIES_PER_SLICE = 256;

/**
 * How to name the worker so Bun will load it — the same two spellings, for the same reasons, as
 * `extensionHostWorkerSpec` in extension.service.ts: anchored to this module from source, and
 * relative to the build's main entry (`src/index.ts`) when compiled.
 */
export function fileIndexWorkerSpec(compiled: boolean = isCompiledBinary()): string {
  return compiled
    ? "./services/file-index/file-index-worker.ts"
    : new URL("./file-index-worker.ts", import.meta.url).href;
}

type WalkRequest = Extract<IndexRequest, { type: "walk" }>;
type SearchRequest = Extract<IndexRequest, { type: "search" }>;

interface PendingWalk { request: WalkRequest; resolve: (build: IndexBuild) => void; reject: (e: Error) => void }
interface PendingSearch { request: SearchRequest; build: IndexBuild; resolve: (files: FileEntry[]) => void; reject: (e: Error) => void }

export class FileIndexRunner {
  private worker: Worker | null = null;
  private failed = false;
  private nextId = 1;
  private readonly walks = new Map<number, PendingWalk>();
  private readonly searches = new Map<number, PendingSearch>();
  /** Which walk of each project the worker holds for searching, by the build's hash. */
  private readonly workerHolds = new Map<string, string>();
  /** The same, searched on this thread, for when no worker runs. */
  private readonly heldHere = new Map<string, { hash: string; index: SearchableIndex }>();

  constructor(private readonly spec: string = fileIndexWorkerSpec()) {}

  /** Whether walks now run on this thread, because the worker could not be started or died. */
  get onMainThread(): boolean {
    return this.failed;
  }

  run(rootPath: string, filter: IndexFilter): Promise<IndexBuild> {
    const worker = this.ensureWorker();
    if (!worker) return walkHere(rootPath, filter);
    return new Promise((resolve, reject) => {
      const request: WalkRequest = { type: "walk", id: this.nextId++, rootPath, filter };
      this.walks.set(request.id, { request, resolve, reject });
      worker.postMessage(request);
    });
  }

  /**
   * The best `limit` entries of `build` for `query`, best first (see `searchIndex`). `build` is
   * the list the caller serves: the worker is handed a copy only when it holds another one —
   * a walk it finished that the caller dropped, or none, for a project short enough to send.
   */
  search(rootPath: string, build: IndexBuild, query: string, kind: SearchKind, limit: number): Promise<FileEntry[]> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(this.searchHere(rootPath, build, query, kind, limit));
    if (this.workerHolds.get(rootPath) !== build.hash) {
      worker.postMessage({ type: "seed", rootPath, json: build.json } satisfies IndexRequest);
      this.workerHolds.set(rootPath, build.hash);
    }
    return new Promise((resolve, reject) => {
      const request: SearchRequest = { type: "search", id: this.nextId++, rootPath, query, kind, limit };
      this.searches.set(request.id, { request, build, resolve, reject });
      worker.postMessage(request);
    });
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.failed) return this.worker;
    let worker: Worker;
    try {
      worker = new Worker(this.spec, { type: "module" });
    } catch (e) {
      this.fail(e as Error);
      return null;
    }
    worker.addEventListener("message", (event: MessageEvent<IndexReply>) => {
      const reply = event.data;
      const walk = this.walks.get(reply.id);
      const search = this.searches.get(reply.id);
      this.walks.delete(reply.id);
      this.searches.delete(reply.id);
      if (!reply.ok) (walk ?? search)?.reject(new Error(reply.error));
      else if ("build" in reply && walk) {
        if (reply.searchable) this.workerHolds.set(walk.request.rootPath, reply.build.hash);
        walk.resolve(reply.build);
      } else if ("files" in reply && search) search.resolve(reply.files);
    });
    worker.addEventListener("error", (event) => this.fail(new Error(event.message)));
    worker.addEventListener("close", () => {
      if (this.worker === worker) this.fail(new Error("the worker exited"));
    });
    // Its walks are all someone's request; an idle worker must not keep the process alive.
    (worker as Worker & { unref(): void }).unref();
    this.worker = worker;
    return worker;
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    console.warn(`[file-index] walking on the main thread: the index worker failed (${error.message})`);
    const walks = [...this.walks.values()];
    const searches = [...this.searches.values()];
    this.walks.clear();
    this.searches.clear();
    for (const { request, resolve, reject } of walks) {
      walkHere(request.rootPath, request.filter).then(resolve, reject);
    }
    for (const { request, build, resolve } of searches) {
      resolve(this.searchHere(request.rootPath, build, request.query, request.kind, request.limit));
    }
  }

  private searchHere(rootPath: string, build: IndexBuild, query: string, kind: SearchKind, limit: number): FileEntry[] {
    let held = this.heldHere.get(rootPath);
    if (held?.hash !== build.hash) {
      const entries = JSON.parse(new TextDecoder().decode(build.json)).data as FileEntry[];
      held = { hash: build.hash, index: toSearchable(entries) };
      this.heldHere.set(rootPath, held);
    }
    return searchIndex(held.index, query, kind, limit);
  }
}

async function walkHere(rootPath: string, filter: IndexFilter): Promise<IndexBuild> {
  const started = performance.now();
  const entries = await walkIndex(rootPath, filter, MAIN_THREAD_ENTRIES_PER_SLICE);
  const { json, hash } = serializeIndex(entries);
  // zlib's thread pool, not `Bun.gzipSync`: nxsys-workspace's list is 22 MB (see gzip-json.ts).
  const gzipped = new Uint8Array(await gzipAsync(json));
  return { json, gzip: gzipped, hash, count: entries.length, walkMs: performance.now() - started };
}

/** The runner the index service uses. */
export const fileIndexRunner = new FileIndexRunner();
