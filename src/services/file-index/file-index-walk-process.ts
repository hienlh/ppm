/**
 * The file index walk, as a process of its own: `<bin> __file_index_walk__` (compiled) or
 * `bun run file-index-walk-process.ts __file_index_walk__` (source), spawned once per walk by
 * `FileIndexRunner`. It takes `{ rootPath, filter }` as JSON in the argument after the sentinel —
 * not on stdin, which the parent can only feed when its event loop is free, so a busy server
 * would hold the walk back — walks, writes the build to stdout and exits. The exit is the
 * point: the operating system takes back
 * everything the walk allocated. A walk on a long-lived worker left that worker holding 1-3 GB of
 * a 1.17M-entry walk, and terminating Bun Workers instead leaks ~29 MB per worker on Windows
 * (Bun 1.3.12, measured), so neither thread could give the memory back.
 *
 * Output: one JSON header line (`WalkHeader`), then the header's byte ranges back to back.
 * Nothing here may reach the config store or the database: the filter arrives resolved.
 */
import { prepareBuild, walkIndex, type IndexFilter } from "./index-walk.ts";

export const WALK_PROCESS_SENTINEL = "__file_index_walk__";

export interface WalkRequestBody {
  rootPath: string;
  filter: IndexFilter;
}

/** What precedes the payload on stdout. Lengths are of the byte ranges that follow, in order. */
export interface WalkHeader {
  ok: true;
  hash: string;
  count: number;
  walkMs: number;
  large: boolean;
  truncated: boolean;
  jsonBytes: number;
  gzipBytes: number;
  compactBytes: number;
  /** This process's peak resident memory, for the log line. */
  peakRssMB: number;
}

/** No other work shares this process, so the walk never needs to hand its thread back. */
const NO_YIELD = Number.MAX_SAFE_INTEGER;

async function main(): Promise<void> {
  try {
    const request = JSON.parse(process.argv[process.argv.indexOf(WALK_PROCESS_SENTINEL) + 1] ?? "") as WalkRequestBody;
    const started = performance.now();
    const { entries, truncated } = await walkIndex(request.rootPath, request.filter, NO_YIELD);
    const prepared = prepareBuild(entries, truncated);
    const gzip = prepared.large ? new Uint8Array() : Bun.gzipSync(prepared.json);
    const compact = prepared.compact ?? new Uint8Array();
    const header: WalkHeader = {
      ok: true,
      hash: prepared.hash,
      count: prepared.count,
      walkMs: performance.now() - started,
      large: prepared.large === true,
      truncated,
      jsonBytes: prepared.json.length,
      gzipBytes: gzip.length,
      compactBytes: compact.length,
      peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    };
    await Bun.write(Bun.stdout, new Blob([JSON.stringify(header) + "\n", prepared.json, gzip, compact]));
    process.exit(0);
  } catch (e) {
    await Bun.write(Bun.stdout, JSON.stringify({ ok: false, error: (e as Error).message }) + "\n");
    process.exit(1);
  }
}

if (process.argv.includes(WALK_PROCESS_SENTINEL)) await main();
