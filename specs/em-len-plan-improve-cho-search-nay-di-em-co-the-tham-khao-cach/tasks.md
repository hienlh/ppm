# Implementation Plan: em lên plan improve chỗ search này đi em... có thể tham khảo cách làm của vs…

<!-- One checkbox per task. Under each, the lines PPM reads:
       _Requirements: 1.1, 1.2_   which acceptance criteria it implements
       _Deps: 1_                  tasks that must finish first (tasks without deps run in parallel)
       _Files: src/a.ts, src/b.ts_ every file it will create or change (tasks sharing a file never run together)
       _Test: tests/a.test.ts_     its test files (Thorough: they must fail first, then pass)
       _Test: none — reason_       when a task cannot have a test
     Mark an optional task with an asterisk: - [ ]* 4. Title -->

- [x] 1. Shared search types, limits and the stdin/stdout frame codec
  - `SearchRequest`/`SearchMatch`/`SearchResponse`/`ReplaceRequest`/`ReplaceReport`, `MAX_MATCHES`, `TIME_LIMIT_MS`, preview sizes; `encodeFrame` + incremental `FrameDecoder` that returns payload `subarray`s without copying, across split and packed chunks.
  - _Requirements: 7.1, 7.2_
  - _Files: src/services/content-search/search-options.ts, src/services/content-search/frame-codec.ts_
  - _Test: tests/unit/services/content-search/frame-codec.test.ts_

- [x] 2. ripgrep argv, VS Code glob conversion and the grep file-list plan
  - rg: `--json --hidden --no-config --engine auto --path-separator=/`, `-F`, `-i`, `-w` together with regex, `-r` (literal `$` → `$$`), `-g`/`-g !`, `--no-ignore` and no default excludes when ignore files are off. grep: file list from `git ls-files -z -co --exclude-standard` or a pruned walk, filtered with `file-glob.ts`, batched under 24 KB of argv.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.3_
  - _Deps: 1_
  - _Files: src/services/content-search/search-args.ts_
  - _Test: tests/unit/services/content-search/search-args.test.ts_

- [x] 3. Parse rg `--json` into matches, and Preserve Case
  - One match per submatch, byte offsets → UTF-16 columns (`é`, emoji), preview `before`/`after` cut around the match with `cutBefore`, rg's own `replacement`, lossy decode of `lines.bytes`; VS Code's case-preserving replace.
  - _Requirements: 1.2, 4.1, 5.2, 5.3_
  - _Deps: 1_
  - _Files: src/services/content-search/rg-json-parse.ts, src/services/content-search/preserve-case.ts_
  - _Test: tests/unit/services/content-search/rg-json-parse.test.ts, tests/unit/services/content-search/preserve-case.test.ts_

- [x] 4. grep fallback: match columns and replacements in JS
  - Literal `indexOf` (with/without case), regex via `RegExp`; a pattern JS cannot run matches the whole line and sets `replaceUnavailable`.
  - _Requirements: 1.2, 5.2_
  - _Deps: 1_
  - _Files: src/services/content-search/grep-matches.ts_
  - _Test: tests/unit/services/content-search/grep-matches.test.ts_

- [x] 5. `runSearch`: every match, 20,000 limit, 30 s limit, cancel, engine errors
  - Runs rg (or the grep plan), no per-file cap, stops at `MAX_MATCHES` (`limitHit`) or `TIME_LIMIT_MS` (`incomplete: "timeout"`, matches kept), abort kills the tool, sorts by path, totals, regex errors in the engine's own words with 400, no tool → 503.
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 3.1, 3.2, 3.3_
  - _Deps: 2, 3, 4_
  - _Files: src/services/content-search/search-run.ts_
  - _Test: tests/unit/services/content-search/search-run.test.ts_

- [x] 6. `runReplace`: verify each match, rewrite from the end, report
  - Realpath inside the project, no `.git`/`node_modules`, `isCredentialPath` refused; a match not found at its line/column skips the whole file (`changed`); write errors go to `failed`; other files still replaced.
  - _Requirements: 5.4, 5.5, 5.6, 5.7_
  - _Deps: 1_
  - _Files: src/services/content-search/replace-run.ts_
  - _Test: tests/unit/services/content-search/replace-run.test.ts_

- [x] 7. The search host process and its main-thread client
  - `ppm __search__` (`resolveEntryMode` → `"search"`), `ready` handshake, dispatch, `cancel`, gzip in the host, at most 4 searches at once, exits on stdin EOF. Client: lazy spawn (compiled vs source command), 5 s ready timeout → 503 with one WARN and no fallback, crash → error then a fresh host, 35 s watchdog kills a hung host, `onMainThreadTask` hook, `stop()` on server shutdown. No database or config in the host's import graph. Gotchas in the new `CLAUDE.md`.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - _Deps: 5, 6_
  - _Files: src/services/content-search/search-host.ts, src/services/content-search/search-host-client.ts, src/services/content-search/CLAUDE.md, src/index.ts, src/server/index.ts_
  - _Test: tests/unit/services/content-search/search-host-client.test.ts, tests/unit/services/content-search/search-host-imports.test.ts, tests/unit/cli/resolve-entry-mode.test.ts_

- [x] 8. Routes: `GET /files/search` and `POST /files/replace` through the host
  - Empty `q` warms the host; the request's abort signal cancels; `server.timeout(req, 40)`; the reply `Blob` is sent as is with `Content-Encoding` when gzipped; the replace body goes to the host as raw bytes. `searchProjectContent` leaves `project-content-search.service.ts` (the tool resolvers stay) and its tests go with it.
  - _Requirements: 1.5, 3.2, 7.1, 7.2_
  - _Deps: 7_
  - _Files: src/server/routes/files.ts, src/services/project-content-search.service.ts, tests/unit/services/project-content-search.test.ts_
  - _Test: tests/unit/server/files-search-route.test.ts_

- [x] 9. Result rows model (pure)
  - List and tree rows, counts without dismissed matches, `matchKey`, collapse/expand all, F4 / Shift+F4 next/previous with wrap, ↑↓←→ focus moves, `ReplaceRequest` for one match / one file / everything left, `filtersActive`.
  - _Requirements: 1.6, 2.6, 4.4, 4.5, 4.6, 5.4, 5.5, 6.1, 6.2_
  - _Deps: 1_
  - _Files: src/web/lib/search/search-rows.ts_
  - _Test: tests/unit/web/search/search-rows.test.ts_

- [x] 10. Search store and client
  - Per-project state kept outside the component, View as Tree/List remembered, 20 queries of history per project in localStorage; debounced requests (query and, while open, replace), one `AbortController` per search, older search aborted first, `POST /files/replace`.
  - _Requirements: 1.5, 4.6, 6.3, 6.5, 6.6_
  - _Deps: 1_
  - _Files: src/web/stores/search-store.ts, src/web/lib/search/search-client.ts_
  - _Test: tests/unit/web/search/search-store.test.ts, tests/unit/web/search/search-client.test.ts_

- [x] 11. Editor: open a match selected, and report unsaved tabs and the selection
  - `metadata.selection` → select the matched text and reveal it; `open-editors-registry` holds the unsaved `project:path` set and the focused editor's selection.
  - _Requirements: 4.2, 5.8, 6.4_
  - _Files: src/web/lib/open-editors-registry.ts, src/web/components/editor/code-editor.tsx_
  - _Test: tests/unit/web/search/open-editors-registry.test.ts, tests/unit/web/search/code-editor-selection.test.ts_

- [x] 12. Virtualised results list and result rows
  - `@tanstack/react-virtual`, 22 px rows (44 px on phone); preview with `…`, exact server ranges highlighted, old text struck through beside the new one; Replace/Dismiss on a match, Replace All in File/Copy Path/Dismiss on a file, on hover or focus, always shown on phone (file ··· opens a bottom sheet); ↑↓←→ Enter, Delete, Ctrl+Shift+1.
  - _Requirements: 3.4, 4.1, 4.3, 4.4, 4.6, 5.1, 6.1, 6.7, 7.8_
  - _Deps: 9, 10_
  - _Screen: 1 · Search with replace and filters open; 2 · View as Tree, filters folded, replace hidden; 5 · Phone (mobile drawer, below 768 px)_
  - _Files: src/web/components/explorer/search-results.tsx, src/web/components/explorer/search-result-row.tsx_
  - _Test: tests/unit/web/search/search-results.test.tsx_

- [x] 13. Replace All dialog and report
  - Confirmation with match and file counts (dismissed left out), then replaced / skipped (unsaved, changed on disk) / failed with reasons; unsaved files never sent.
  - _Requirements: 5.5, 5.7, 5.8_
  - _Deps: 9, 10_
  - _Screen: 4 · Replace All asks first, then reports what happened_
  - _Files: src/web/components/explorer/replace-all-dialog.tsx_
  - _Test: tests/unit/web/search/replace-all-dialog.test.tsx_

- [x] 14. Search panel
  - Toolbar (Refresh, Clear, Collapse/Expand All, View as Tree/List), Aa/ab/.* inside the field, replace chevron with AB and Replace All, ··· details with include/exclude and the eye-off toggle plus the active dot, status line, banners (limit, timeout, grep, errors with Retry), engine regex error under the field; Alt+C/W/R/P, Alt+↑/↓ history, ↓ into the results; one match / one file replace with the status-line report.
  - _Requirements: 1.3, 1.4, 1.6, 2.6, 3.2, 3.5, 4.5, 5.4, 6.1, 6.3, 7.5_
  - _Deps: 10, 11, 12, 13_
  - _Screen: 1 · Search with replace and filters open; 2 · View as Tree, filters folded, replace hidden; 3 · What the panel says when something is not a plain result; 5 · Phone (mobile drawer, below 768 px)_
  - _Files: src/web/components/explorer/search-panel.tsx_
  - _Test: tests/unit/web/search/search-panel.test.tsx_

- [x] 15. Global keys: search the selection, F4 / Shift+F4
  - `open-search` seeds a one-line editor selection as the query; `search-next-match` / `search-prev-match` open the next/previous match of the active project.
  - _Requirements: 6.2, 6.4_
  - _Deps: 9, 10, 11_
  - _Screen: 6 · Keyboard_
  - _Files: src/web/hooks/use-global-keybindings.ts, src/web/stores/keybindings-store.ts_
  - _Test: tests/unit/web/search/search-keybindings.test.ts_

- [x] 16. Docs and changelog
  - Search section in `docs/architecture/workspace-and-ui.md`, the search host in root `CLAUDE.md` → Architecture, `CHANGELOG.md` [Unreleased].
  - _Deps: 8, 14, 15_
  - _Files: docs/architecture/workspace-and-ui.md, CLAUDE.md, CHANGELOG.md_
  - _Test: none — documentation only_

- [ ]* 17. Measure on a big project with a scratch build
  - Build into a scratch outfile, run a scratch server on an odd port with a scratch `PPM_HOME`, search `e` in nxsys-workspace and Replace All ~1,000 matches; the log must show no `Event loop stalled` caused by search.
  - _Requirements: 7.3_
  - _Deps: 8, 14, 18_
  - _Files: none_
  - _Test: none — manual measurement against the live-size project, nothing to commit_

- [x] 18. "Files to include" must not bring back ignored files
  - ripgrep's `-g` always overrides ignore rules, so while ignore files are on an include like `src` or `*.ts` listed files `.gitignore` excludes (measured: `src/server/y.ts` came back with `src/server/` ignored). While `useIgnore` is on, includes no longer go to rg as `-g`: the literal folder prefix of each include becomes a search path (rg keeps applying the root `.gitignore` under it; nested prefixes collapse into one, and paths that do not exist are dropped, since rg exits 2 on them), and `runSearch` keeps only files matching the includes (`matchesGlob` over `toRipgrepGlobs`) before counting toward `MAX_MATCHES`. With `useIgnore` off, `-g` stays. Update task 2's argv tests to the new form, and fix the `tsc` error at `grep-matches.ts:106` (`string | undefined`).
  - _Requirements: 2.1, 2.4, 2.5_
  - _Deps: 2, 5_
  - _Files: src/services/content-search/search-args.ts, src/services/content-search/search-run.ts, src/services/content-search/grep-matches.ts, tests/unit/services/content-search/search-args.test.ts_
  - _Test: tests/unit/services/content-search/search-include-ignore.test.ts_
