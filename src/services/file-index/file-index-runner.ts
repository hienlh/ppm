/**
 * Runs index walks in a process of their own, searches on a search worker per project, and both
 * on this thread when neither can run.
 *
 * A walk leaves whatever ran it holding far more than the list it produced: 1.17M entries left a
 * long-lived worker at 1-3 GB, never returned. Ending a Bun Worker does not help on Windows — each
 * terminated worker leaks ~29 MB (Bun 1.3.12, measured: 40 empty workers, +1.15 GB) — so every walk
 * runs in a child process (`file-index-walk-process.ts`) and the operating system takes its memory
 * back when it exits. A list searched on the server lives on one search worker per project, kept
 * for the life of the runner and re-seeded with each newer build.
 *
 * A compiled build only has a worker that is one of its entry points (the `build` script,
 * `scripts/release.sh` and the release workflow all name it, and release-compile-entries.test.ts
 * keeps them agreeing), and there a worker that cannot load fails with an error event after it
 * was constructed, not with a throw. The walk process is the binary itself (`<bin>
 * __file_index_walk__`, routed by `src/index.ts`). Whatever cannot run elsewhere is re-run here:
 * a missing worker or walk process costs the event loop the work, never a caller its answer.
 */
import { resolve } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { isCompiledBinary } from "../autostart-generator.ts";
import type { FileEntry } from "../../types/project.ts";
import { buildEntries, prepareBuild, walkIndex, type IndexBuild, type IndexFilter } from "./index-walk.ts";
import { searchIndex, toSearchable, type SearchableIndex, type SearchKind } from "./index-search.ts";
import type { IndexReply, IndexRequest } from "./file-index-worker.ts";
import { WALK_PROCESS_SENTINEL, type WalkHeader, type WalkRequestBody } from "./file-index-walk-process.ts";

const gzipAsync = promisify(gzip);

/**
 * Entries per slice when walking on this thread. An entry costs a few glob tests and two gitignore
 * checks — ~34 µs on nxsys-workspace — so a slice is about 10 ms, which is as long as a health
 * probe or a chat stream waits. Counted rather than timed so that how often it yields does not
 * depend on the machine.
 */
const MAIN_THREAD_ENTRIES_PER_SLICE = 256;

/**
 * How to name the search worker so Bun will load it — the same two spellings, for the same
 * reasons, as `extensionHostWorkerSpec` in extension.service.ts: anchored to this module from
 * source, and relative to the build's main entry (`src/index.ts`) when compiled.
 */
export function fileIndexWorkerSpec(compiled: boolean = isCompiledBinary()): string {
  return compiled
    ? "./services/file-index/file-index-worker.ts"
    : new URL("./file-index-worker.ts", import.meta.url).href;
}

/** The command line of a walk process: the binary itself when compiled, `bun run` from source. */
export function fileIndexWalkCommand(compiled: boolean = isCompiledBinary()): string[] {
  return compiled
    ? [process.execPath, WALK_PROCESS_SENTINEL]
    : [process.execPath, "run", resolve(import.meta.dir, "file-index-walk-process.ts"), WALK_PROCESS_SENTINEL];
}

export interface FileIndexRunnerOptions {
  /** The walk process's command line; `fileIndexWalkCommand()` unless a test says otherwise. */
  walkCommand?: string[];
  /** The search worker's module; `fileIndexWorkerSpec()` unless a test says otherwise. */
  searchSpec?: string;
}

interface PendingSearch {
  query: string;
  kind: SearchKind;
  limit: number;
  build: IndexBuild;
  resolve: (files: FileEntry[]) => void;
}

/** One project's search worker, and the build it holds. */
interface Searcher {
  worker: Worker;
  hash: string;
  pending: Map<number, PendingSearch>;
}

export class FileIndexRunner {
  private walksFailed = false;
  private searchFailed = false;
  private nextId = 1;
  private readonly walkCommand: string[];
  private readonly searchSpec: string;
  /** Walk processes running now. */
  private readonly walking = new Set<ReturnType<typeof Bun.spawn>>();
  private readonly searchers = new Map<string, Searcher>();
  /** The lists searched on this thread, for when no search worker runs. */
  private readonly heldHere = new Map<string, { hash: string; index: SearchableIndex }>();

  constructor(options: FileIndexRunnerOptions = {}) {
    this.walkCommand = options.walkCommand ?? fileIndexWalkCommand();
    this.searchSpec = options.searchSpec ?? fileIndexWorkerSpec();
  }

  /** Whether walks now run on this thread, because a walk process could not run. */
  get onMainThread(): boolean {
    return this.walksFailed;
  }

  /** Walk processes running and search workers alive, now. */
  get liveCount(): { walks: number; searchers: number } {
    return { walks: this.walking.size, searchers: this.searchers.size };
  }

  async run(rootPath: string, filter: IndexFilter): Promise<IndexBuild> {
    if (this.walksFailed) return walkHere(rootPath, filter);
    try {
      return await this.walkInProcess({ rootPath, filter });
    } catch (e) {
      if (e instanceof WalkError) throw e;
      this.walksFailed = true;
      console.warn(`[file-index] walking on the main thread: the walk process failed (${(e as Error).message})`);
      return walkHere(rootPath, filter);
    }
  }

  /**
   * The best `limit` entries of `build` for `query`, best first (see `searchIndex`). `build` is
   * the list the caller serves; the project's search worker is re-seeded when it holds another.
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
    for (const proc of this.walking) proc.kill();
    this.walking.clear();
    const searchers = [...this.searchers.values()];
    this.searchers.clear();
    for (const searcher of searchers) {
      searcher.pending.clear();
      searcher.worker.terminate();
    }
  }

  private async walkInProcess(request: WalkRequestBody): Promise<IndexBuild> {
    // Throws at once for a binary that is not there; `run` falls back to this thread. The request
    // rides on the command line so the walk starts at spawn, whatever this thread is doing.
    const proc = Bun.spawn([...this.walkCommand, JSON.stringify(request)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    this.walking.add(proc);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
      return parseWalkOutput(new Uint8Array(out), code);
    } finally {
      this.walking.delete(proc);
    }
  }

  private searcherFor(rootPath: string, build: IndexBuild): Searcher | null {
    let searcher = this.searchers.get(rootPath);
    if (!searcher) {
      if (this.searchFailed) return null;
      const worker = this.startSearchWorker(rootPath);
      if (!worker) return null;
      searcher = { worker, hash: "", pending: new Map() };
      this.searchers.set(rootPath, searcher);
    }
    if (searcher.hash !== build.hash) {
      // A copy, not a transfer: the caller's build keeps its bytes to serve and to search here.
      const seed: IndexRequest = build.compact
        ? { type: "seed", compact: build.compact.slice() }
        : { type: "seed", json: build.json.slice() };
      searcher.worker.postMessage(seed, [(seed.compact ?? seed.json)!.buffer]);
      searcher.hash = build.hash;
    }
    return searcher;
  }

  private startSearchWorker(rootPath: string): Worker | null {
    let worker: Worker;
    try {
      worker = new Worker(this.searchSpec, { type: "module" });
    } catch (e) {
      this.searchWorkerLost(rootPath, null, (e as Error).message);
      return null;
    }
    // Its searches are all someone's request; an idle worker must not keep the process alive.
    (worker as Worker & { unref(): void }).unref();
    worker.addEventListener("message", (event: MessageEvent<IndexReply>) => {
      const searcher = this.searchers.get(rootPath);
      const pending = searcher?.worker === worker ? searcher.pending.get(event.data.id) : undefined;
      if (!pending) return;
      searcher!.pending.delete(event.data.id);
      const reply = event.data;
      pending.resolve(reply.ok ? reply.files : this.searchHere(rootPath, pending.build, pending.query, pending.kind, pending.limit));
    });
    worker.addEventListener("error", (event) => this.searchWorkerLost(rootPath, worker, event.message));
    worker.addEventListener("close", () => this.searchWorkerLost(rootPath, worker, "the worker exited"));
    return worker;
  }

  /** A search worker could not start or died: answer what it held here, and search here from now on. */
  private searchWorkerLost(rootPath: string, worker: Worker | null, why: string): void {
    const searcher = this.searchers.get(rootPath);
    if (worker && searcher?.worker !== worker) return; // already handled, or closed on purpose
    this.searchers.delete(rootPath);
    worker?.terminate();
    if (!this.searchFailed) {
      this.searchFailed = true;
      console.warn(`[file-index] searching on the main thread: the search worker failed (${why})`);
    }
    for (const p of searcher?.pending.values() ?? []) {
      p.resolve(this.searchHere(rootPath, p.build, p.query, p.kind, p.limit));
    }
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

/** A build from a walk process's stdout (see `WalkHeader`), or why there is none. */
export function parseWalkOutput(out: Uint8Array, exitCode: number | null): IndexBuild {
  const newline = out.indexOf(10);
  if (newline < 0) throw new Error(`the walk process exited with code ${exitCode} and no answer`);
  const header = JSON.parse(new TextDecoder().decode(out.subarray(0, newline))) as WalkHeader | { ok: false; error: string };
  if (!header.ok) throw new WalkError(header.error);
  let at = newline + 1;
  // Copies, so each buffer is its own and the whole stdout read can be let go.
  const take = (n: number) => out.slice(at, (at += n));
  const json = take(header.jsonBytes);
  const gzipped = take(header.gzipBytes);
  const compact = take(header.compactBytes);
  if (at !== out.length) throw new Error(`the walk process sent ${out.length} bytes, its header promised ${at}`);
  return {
    json,
    gzip: gzipped,
    hash: header.hash,
    count: header.count,
    walkMs: header.walkMs,
    large: header.large,
    truncated: header.truncated,
    ...(header.large && { compact }),
    peakMB: header.peakRssMB,
  };
}

/** The walk itself failed (an unreadable root, say): the same answer on any thread, so no fallback. */
export class WalkError extends Error {}

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
