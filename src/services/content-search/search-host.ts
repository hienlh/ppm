/**
 * The search host — `ppm __search__`, the process every content search and replace runs in.
 *
 * The server spawns it once (`search-host-client.ts`) and talks to it over stdin/stdout in the
 * frames of `frame-codec.ts`. It answers `ready` as soon as it reads, runs each `search` through
 * `runSearch` (at most `MAX_CONCURRENT` at once, the rest queued) and each `replace` through
 * `runReplace`, and drops a search on `cancel`, which kills its ripgrep/grep. It exits when its
 * stdin closes, i.e. when the server goes away.
 *
 * Payloads:
 * - `search`: the JSON `SearchRequest`.
 * - `replace`: `[u32 path length][project path, UTF-8][the browser's raw `{ files }` JSON]`
 *   (`replacePayload` in the client), so the server never parses the body.
 * - `reply`: `[u8 flags][body]`, flag bit 0 = the body is gzipped (asked for by `SearchRequest.gzip`).
 * - `reply-error`: JSON `{ status, message }`. A cancelled search gets no answer at all.
 *
 * Its import graph reaches no database or config (`search-host-imports.test.ts`). The Windows spawn
 * guard is installed by `src/index.ts` before it routes here, for every mode.
 */
import type { ReplaceReport, ReplaceRequest, SearchRequest, SearchResponse } from "./search-options.ts";
import { encodeFrame, type Frame, FrameDecoder, type FrameKind } from "./frame-codec.ts";
import { runReplace as defaultRunReplace } from "./replace-run.ts";
import { runSearch as defaultRunSearch, SearchRunError } from "./search-run.ts";

export const MAX_CONCURRENT = 4;

export interface HostDispatcherDeps {
  runSearch?: (projectPath: string, req: SearchRequest, signal: AbortSignal) => Promise<SearchResponse>;
  runReplace?: (projectPath: string, req: ReplaceRequest) => Promise<ReplaceReport>;
  send: (bytes: Uint8Array) => void;
  maxConcurrent?: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function joinParts(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

/** `[u32 path length][path][body]` → the project path and the body. */
function decodeReplacePayload(payload: Uint8Array): { projectPath: string; body: Uint8Array } {
  if (payload.byteLength < 4) throw new Error("Malformed replace request");
  const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
  if (4 + length > payload.byteLength) throw new Error("Malformed replace request");
  return {
    projectPath: decoder.decode(payload.subarray(4, 4 + length)),
    body: payload.subarray(4 + length),
  };
}

export function createHostDispatcher(deps: HostDispatcherDeps): { handle(frame: Frame): void } {
  const runSearch = deps.runSearch ?? defaultRunSearch;
  const runReplace = deps.runReplace ?? defaultRunReplace;
  const max = deps.maxConcurrent ?? MAX_CONCURRENT;
  /** Searches started or queued, by request id. */
  const searches = new Map<number, AbortController>();
  const queue: Array<{ id: number; start: () => void }> = [];
  let running = 0;

  const send = (kind: FrameKind, id: number, payload: Uint8Array) => deps.send(encodeFrame(kind, id, payload));
  const reply = (id: number, body: Uint8Array, gzip: boolean) => {
    const out = new Uint8Array(1 + body.byteLength);
    out[0] = gzip ? 1 : 0;
    out.set(body, 1);
    send("reply", id, out);
  };
  const replyError = (id: number, error: unknown) => {
    const status = error instanceof SearchRunError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    send("reply-error", id, encoder.encode(JSON.stringify({ status, message })));
  };

  const next = () => {
    while (running < max && queue.length) queue.shift()!.start();
  };

  function search(id: number, payload: Uint8Array): void {
    let req: SearchRequest;
    try {
      req = JSON.parse(decoder.decode(payload)) as SearchRequest;
    } catch (error) {
      replyError(id, new SearchRunError(`Malformed search request: ${(error as Error).message}`, 500));
      return;
    }
    const ctrl = new AbortController();
    searches.set(id, ctrl);
    queue.push({
      id,
      start: () => {
        running++;
        runSearch(req.projectPath, req, ctrl.signal)
          .then((response) => {
            if (ctrl.signal.aborted) return;
            const json = encoder.encode(JSON.stringify(response));
            if (req.gzip) reply(id, Bun.gzipSync(json), true);
            else reply(id, json, false);
          })
          .catch((error) => { if (!ctrl.signal.aborted) replyError(id, error); })
          .finally(() => {
            searches.delete(id);
            running--;
            next();
          });
      },
    });
    next();
  }

  function replace(id: number, payload: Uint8Array): void {
    void (async () => {
      try {
        const { projectPath, body } = decodeReplacePayload(payload);
        const parsed = JSON.parse(decoder.decode(body)) as { files?: ReplaceRequest["files"] };
        if (!Array.isArray(parsed?.files)) throw new SearchRunError("Replace request has no files", 400);
        const report = await runReplace(projectPath, { projectPath, files: parsed.files });
        reply(id, encoder.encode(JSON.stringify(report)), false);
      } catch (error) {
        replyError(id, error instanceof SyntaxError ? new SearchRunError(`Malformed replace request: ${error.message}`, 400) : error);
      }
    })();
  }

  function cancel(id: number): void {
    const ctrl = searches.get(id);
    if (!ctrl) return;
    ctrl.abort();
    const queued = queue.findIndex((q) => q.id === id);
    if (queued >= 0) {
      queue.splice(queued, 1);
      searches.delete(id);
    }
  }

  return {
    handle(frame) {
      switch (frame.kind) {
        case "search": return search(frame.id, joinParts(frame.parts));
        case "replace": return replace(frame.id, joinParts(frame.parts));
        case "cancel": return cancel(frame.id);
        default: return;
      }
    },
  };
}

/** Writes a frame to stdout: one `write()` then `flush()` (a FileSink's return value is not progress). */
function stdoutWriter(): (bytes: Uint8Array) => void {
  const sink = Bun.stdout.writer();
  return (bytes) => {
    sink.write(bytes);
    void sink.flush();
  };
}

export async function main(): Promise<void> {
  const send = stdoutWriter();
  const dispatcher = createHostDispatcher({ send });
  const frames = new FrameDecoder();
  send(encodeFrame("ready", 0));
  // `process.stdin`, not `Bun.stdin.stream()`: no `.stream()` on a BunFile anywhere in src (file-chunks.test.ts).
  try {
    for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
      for (const frame of frames.push(chunk)) dispatcher.handle(frame);
    }
  } catch (error) {
    console.error(`[search-host] stdin failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // stdin closed: the server is gone. Running ripgreps die on their next write to a closed pipe.
  process.exit(0);
}
