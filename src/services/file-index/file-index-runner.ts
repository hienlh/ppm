/**
 * Runs index walks and searches on file index workers, or on this thread when no worker can run.
 *
 * Every walk gets a worker of its own, terminated as soon as it answers: a walk leaves its thread
 * holding far more than the list it produced (1.17M entries left a long-lived worker at 1-3 GB,
 * never returned), and ending the thread is what gives that back. A list searched on the server
 * is handed to a search worker of its own, one per project, replaced when a newer build of that
 * project is searched.
 *
 * A compiled build only has a worker that is one of its entry points (the `build` script,
 * `scripts/release.sh` and the release workflow all name it, and release-compile-entries.test.ts
 * keeps them agreeing), and there a worker that cannot load fails with an error event after it
 * was constructed, not with a throw. So everything it was given is re-run here: a missing worker
 * costs the event loop the walk, which is where every walk ran before, and never costs a caller
 * its answer.
 */
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { isCompiledBinary } from "../autostart-generator.ts";
import type { FileEntry } from "../../types/project.ts";
import { buildEntries, prepareBuild, walkIndex, type IndexBuild, type IndexFilter } from "./index-walk.ts";
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

interface PendingSearch {
  query: string;
  kind: SearchKind;
  limit: number;
  build: IndexBuild;
  resolve: (files: FileEntry[]) => void;
}

/** The worker searching one build of one project. */
interface Searcher {
  worker: Worker;
  hash: string;
  pending: Map<number, PendingSearch>;
  /** A newer build replaced it: it ends once its last search is answered. */
  retired: boolean;
}

export class FileIndexRunner {
  private failed = false;
  private nextId = 1;
  /** Workers walking now, each with what ends it without counting as a failure. */
  private readonly walking = new Map<Worker, () => void>();
  private readonly searchers = new Map<string, Searcher>();
  /** The lists searched on this thread, for when no worker runs. */
  private readonly heldHere = new Map<string, { hash: string; index: SearchableIndex }>();

  constructor(private readonly spec: string = fileIndexWorkerSpec()) {}

  /** Whether walks now run on this thread, because a worker could not be started or died. */
  get onMainThread(): boolean {
    return this.failed;
  }

  /** Workers alive now, walking or searching. */
  get workerCount(): number {
    return this.walking.size + this.searchers.size;
  }

  run(rootPath: string, filter: IndexFilter): Promise<IndexBuild> {
    const worker = this.startWorker();
    if (!worker) return walkHere(rootPath, filter);
    return new Promise((resolve, reject) => {
      let settled = false;
      const end = () => {
        settled = true;
        this.walking.delete(worker);
        worker.terminate();
      };
      this.walking.set(worker, end);
      const fallBack = (why: string) => {
        if (settled) return;
        end();
        this.fail(why);
        walkHere(rootPath, filter).then(resolve, reject);
      };
      worker.addEventListener("message", (event: MessageEvent<IndexReply>) => {
        if (settled) return;
        end();
        const reply = event.data;
        if (!reply.ok) reject(new Error(reply.error));
        else if ("build" in reply) resolve(reply.build);
        else reject(new Error("the index worker answered a walk with something else"));
      });
      worker.addEventListener("error", (event) => fallBack(event.message));
      worker.addEventListener("close", () => fallBack("the worker exited"));
      worker.postMessage({ type: "walk", id: this.nextId++, rootPath, filter } satisfies IndexRequest);
    });
  }

  /**
   * The best `limit` entries of `build` for `query`, best first (see `searchIndex`). `build` is
   * the list the caller serves; the project's search worker is replaced when it holds another.
   */
  search(rootPath: string, build: IndexBuild, query: string, kind: SearchKind, limit: number): Promise<FileEntry[]> {
    const searcher = this.searcherFor(rootPath, build);
    if (!searcher) return Promise.resolve(this.searchHere(rootPath, build, query, kind, limit));
    return new Promise((resolve) => {
      const id = this.nextId++;
      searcher.pending.set(id, { query, kind, limit, build, resolve });
      searcher.worker.postMessage({ type: "search", id, query, kind, limit } satisfies IndexRequest);
    });
  }

  close(): void {
    for (const end of [...this.walking.values()]) end();
    for (const [rootPath, searcher] of [...this.searchers]) {
      searcher.pending.clear();
      this.retire(rootPath, searcher);
    }
  }

  private startWorker(): Worker | null {
    if (this.failed) return null;
    try {
      const worker = new Worker(this.spec, { type: "module" });
      // Its work is all someone's request; an idle worker must not keep the process alive.
      (worker as Worker & { unref(): void }).unref();
      return worker;
    } catch (e) {
      this.fail((e as Error).message);
      return null;
    }
  }

  private searcherFor(rootPath: string, build: IndexBuild): Searcher | null {
    const held = this.searchers.get(rootPath);
    if (held?.hash === build.hash) return held;
    const worker = this.startWorker();
    if (!worker) return null;
    if (held) this.retire(rootPath, held);
    const searcher: Searcher = { worker, hash: build.hash, pending: new Map(), retired: false };
    this.searchers.set(rootPath, searcher);
    worker.addEventListener("message", (event: MessageEvent<IndexReply>) => {
      const reply = event.data;
      const pending = searcher.pending.get(reply.id);
      if (!pending) return;
      searcher.pending.delete(reply.id);
      if (reply.ok && "files" in reply) pending.resolve(reply.files);
      else pending.resolve(this.searchHere(rootPath, pending.build, pending.query, pending.kind, pending.limit));
      if (searcher.retired && searcher.pending.size === 0) worker.terminate();
    });
    const lost = (why: string) => {
      if (this.searchers.get(rootPath) === searcher) this.searchers.delete(rootPath);
      const pending = [...searcher.pending.values()];
      searcher.pending.clear();
      if (searcher.retired) return;
      searcher.retired = true;
      worker.terminate();
      this.fail(why);
      for (const p of pending) p.resolve(this.searchHere(rootPath, p.build, p.query, p.kind, p.limit));
    };
    worker.addEventListener("error", (event) => lost(event.message));
    worker.addEventListener("close", () => lost("the worker exited"));
    // A copy, not a transfer: the caller's build keeps its bytes to serve and to search here.
    const seed: IndexRequest = build.compact ? { type: "seed", compact: build.compact.slice() } : { type: "seed", json: build.json.slice() };
    worker.postMessage(seed, [seed.compact?.buffer ?? seed.json!.buffer]);
    return searcher;
  }

  private retire(rootPath: string, searcher: Searcher): void {
    if (this.searchers.get(rootPath) === searcher) this.searchers.delete(rootPath);
    searcher.retired = true;
    if (searcher.pending.size === 0) searcher.worker.terminate();
  }

  private fail(why: string): void {
    if (this.failed) return;
    this.failed = true;
    console.warn(`[file-index] walking on the main thread: the index worker failed (${why})`);
  }

  private searchHere(rootPath: string, build: IndexBuild, query: string, kind: SearchKind, limit: number): FileEntry[] {
    let held = this.heldHere.get(rootPath);
    if (held?.hash !== build.hash) {
      held = { hash: build.hash, index: toSearchable(buildEntries(build)) };
      this.heldHere.set(rootPath, held);
    }
    return searchIndex(held.index, query, kind, limit);
  }
}

async function walkHere(rootPath: string, filter: IndexFilter): Promise<IndexBuild> {
  const started = performance.now();
  const { entries, truncated } = await walkIndex(rootPath, filter, MAIN_THREAD_ENTRIES_PER_SLICE);
  const prepared = prepareBuild(entries, truncated);
  // zlib's thread pool, not `Bun.gzipSync`: nxsys-workspace's list is 22 MB (see gzip-json.ts).
  const gzipped = prepared.large ? new Uint8Array() : new Uint8Array(await gzipAsync(prepared.json));
  return { ...prepared, gzip: gzipped, walkMs: performance.now() - started };
}

/** The runner the index service uses. */
export const fileIndexRunner = new FileIndexRunner();
