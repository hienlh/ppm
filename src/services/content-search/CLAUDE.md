# `src/services/content-search/`

The sidebar Search panel's server half: every content search and replace runs in a separate process, the **search host** (`ppm __search__`), never on the server's main thread.

## Map

- `search-host-client.ts` — main thread. `getSearchHost()` spawns the host lazily (`searchHostCommand()`: `<bin> __search__` compiled, `bun run src/index.ts __search__` from a checkout), `request(kind, payload, { signal, deadlineMs })` → `{ body: Blob, gzip }` or `SearchHostError(status, message)`, `stopSearchHost()` on server shutdown. `replacePayload(projectPath, body)` builds a replace frame without copying the body.
- `search-host.ts` — the host. `main()` sends `ready`, reads frames from stdin, `createHostDispatcher` runs at most 4 searches at once (`runSearch`, the rest queued), replaces through `runReplace`, drops a search on `cancel`, gzips a reply when the request asked. Exits on stdin EOF.
- `frame-codec.ts` — `[u8 kind][u32 id][u32 length][payload]`; `FrameDecoder` hands back `subarray`s, never copies.
- `search-run.ts` / `search-args.ts` / `rg-json-parse.ts` / `grep-matches.ts` / `preserve-case.ts` — the search (ripgrep `--json`, GNU grep fallback). `replace-run.ts` — the replace. `search-options.ts` — shared types and limits.

Payloads: `search` = JSON `SearchRequest`; `replace` = `[u32 path length][project path][browser's raw { files } JSON]`; `reply` = `[u8 flags][body]` (bit 0 = gzip); `reply-error` = JSON `{ status, message }`. A cancelled search gets no answer.

## Gotchas

- **Nothing the host imports may reach the database or config**: it is a second process, and `getDb()` opens the real `ppm.db` for whoever asks first. `search-host-imports.test.ts` walks its import graph. The same test keeps the search code out of the client: a host that cannot start is a 503, never a search run in the server.
- **The host's stdout is the protocol**: one stray `console.log` in anything it imports corrupts the frame stream (`Corrupt frame stream: unknown kind`) and every pending search fails. Log to stderr (`console.error`), which the client leaves inherited.
- **Spawn from source through `src/index.ts`, not `search-host.ts`**: `src/index.ts` installs the Windows spawn handle guard before routing to `__search__`, so ripgrep never inherits the server's sockets (`windows-socket-inheritance.ts`). Running `search-host.ts` directly would skip it. The mode is a static literal `import()` in `src/index.ts`, so the host is inside the main entry and needs no extra `bun build` entry point.
- **Main-thread cost is per chunk, not per match**: the client only pushes stdout chunks through `FrameDecoder` and wraps the parts in a `Blob`. Measured with 20,000 matches: 2 callbacks (0.23 ms max) gzipped, 18 (1.1 ms max) for 3.3 MB plain. Do not add parsing, `JSON.parse` of a reply, or `TextDecoder` on the reply path; `onMainThreadTask` is the hook the test measures with. Only `reply-error` (a short JSON) is read on the main thread.
- **Deadlines**: the host stops its tool at `TIME_LIMIT_MS` (30 s) and answers what it found; the client SIGKILLs a host that has not answered a search 5 s after that (a replace gets 5 minutes), because a hung host would hang every later search. Its ripgreps die on their next write to the closed pipe. A host that dies fails its pending requests with 500 and the next request spawns a fresh one; there is no restart loop.
- **Write each part once, then flush**: the client writes the 9-byte header and the payload parts to the host's `FileSink` one `write()` each and `flush()`es once — never a loop on `write()`'s return value (root `CLAUDE.md`, `FileSink.write()`).
