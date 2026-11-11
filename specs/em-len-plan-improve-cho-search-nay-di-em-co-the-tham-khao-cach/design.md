# Design: em lên plan improve chỗ search này đi em... có thể tham khảo cách làm của vs…

## Overview

Panel Search ở sidebar được làm lại theo Search view của VS Code. Màn hình nằm trong design `designs/em-len-plan-improve-cho-search-nay-di-em-co-the-tham-khao-cach/` (6 phần: panel đầy đủ, tree view, các trạng thái, Replace All, phone, phím tắt).

Ba quyết định chính:

1. **Search và replace chạy trong một process riêng, `ppm __search__`** (gọi là *search host*). Không dùng worker thread, vì:
   - Lớp chặn rò socket trên Windows (`windows-socket-inheritance.ts`) chỉ bọc `Bun.spawn` của thread đã cài nó, và một spawn từ worker chạy lúc nó đang quét có thể làm process con mất stdio. Một process riêng đi qua `src/index.ts` nên tự cài lớp chặn của nó, như `__share_host__`.
   - Host chết (rg treo, hết RAM) không kéo server chết theo.
   - Main thread của server chỉ: spawn host **một lần**, ghi request nhỏ vào stdin của host, và ghép các chunk byte trả về thành `Blob` để gửi đi. Không `JSON.parse`, không decode, không sort, không đọc/ghi file của project.
2. **ripgrep `--json` là nguồn sự thật cho cả tìm lẫn thay.** rg trả vị trí từng match (`submatches[].start/end`) và, khi có `-r`, chuỗi thay thế của từng match bằng chính engine của nó (đã thử trên rg 15.2: `$0`, `$1` đúng). Trình duyệt không còn tự dựng regex để highlight hay để thay. `--engine auto` cho phép look-around và back-reference qua PCRE2 như VS Code.
3. **Replace là stateless:** trình duyệt gửi đúng danh sách match đang hiện (file, dòng, cột, chữ khớp, chữ thay). Host đọc file, kiểm từng match còn nằm đúng chỗ, thay từ cuối lên đầu, ghi file. Match nào không khớp nữa thì bỏ cả file và báo.

GNU grep vẫn là phương án dự phòng khi máy không có rg (Windows có Git for Windows). Kết quả cùng hình dạng, nhưng cột và chữ thay được tính bằng JS trong host, nên chỉ khớp tuyệt đối với engine khi dùng rg. Panel báo một dòng khi đang chạy bằng grep.

## Architecture

```
Browser                                Server main thread                    Search host (ppm __search__)
─────────                              ──────────────────                    ────────────────────────────
search-store (per project)
  │ GET /files/search?…  (AbortSignal)
  ├──────────────────────────────────▶ route: build small JSON request
  │                                    searchHost.request("search", bytes) ─▶ frame decode → runSearch()
  │                                                                            spawn rg --json (guarded)
  │                                                                            parse, limit 20k, time 30 s,
  │                                                                            sort, preview slice, gzip
  │                                    reply chunks → Blob  ◀───────────────── frame encode
  │ ◀────────────────────────────────  new Response(blob, Content-Encoding)
  │
  │ POST /files/replace (raw body)
  ├──────────────────────────────────▶ await c.req.arrayBuffer() (no parse)
  │                                    searchHost.request("replace", bytes) ─▶ runReplace(): realpath guard,
  │                                                                            verify, rewrite, write
  │ ◀────────────────────────────────  report Blob               ◀─────────── report
  │
  └ abort (new query, Clear, unmount)  request.signal → host "cancel" frame ──▶ kill that rg
```

- **Spawn host:** `[process.execPath, "__search__"]` khi là binary compile, `[process.execPath, "run", <search-host.ts>]` khi chạy từ source — giống `workerCmd` của share-host. Host khởi động lười ở request search đầu tiên; panel Search mở ra gửi một `GET /files/search` rỗng để làm ấm host (người dùng ưu tiên phản hồi tức thì hơn RAM, chừng 40–60 MB cho một process Bun rảnh). Host sống tới khi server tắt: stdin của nó đóng thì nó thoát.
- **Giao thức stdin/stdout:** khung nhị phân `[u8 kind][u32 id][u32 length][payload]`. Kind: `ready`, `search`, `replace`, `cancel`, `reply`, `reply-error`. Main thread chỉ đọc 9 byte header và giữ các `subarray` của payload (không copy) cho tới khi đủ `length`, rồi `new Blob(parts)`. Payload request do main dựng là JSON nhỏ (search) hoặc byte thô của body (replace).
- **Không có fallback về main thread:** host không spawn được, không gửi `ready` trong 5 s, hoặc chết → request đang chờ nhận lỗi `503`/`500` có lý do, ghi một dòng `WARN`; request sau spawn host mới. Không có nhánh code nào chạy search trong process server.
- **Watchdog:** mỗi request search có hạn `30 s + 5 s`. Host tự dừng rg ở 30 s và trả kết quả dở (`incomplete: "timeout"`); nếu tới 35 s vẫn không có reply thì main giết host (SIGKILL) và trả lỗi. rg con của host chết theo khi pipe stdout của nó đóng.
- **Đồng thời:** host chạy tối đa 4 rg cùng lúc, request thứ 5 chờ. Trình duyệt luôn hủy search cũ trước khi gửi search mới.
- **Build:** host là một mode của `src/index.ts` (`resolveEntryMode` → `"search"`, import tĩnh theo literal path), nên nằm trong entry chính, không cần entry point thứ tư. `release-compile-entries.test.ts` giữ nguyên; test của `resolveEntryMode` thêm `__search__`.
- **Database:** host không import gì chạm config hay DB (như `file-glob.ts`). Một test kiểm graph import của `search-host.ts` không chứa `db.service`/`config.service`.

## Components and Interfaces

### Server — `src/services/content-search/` (mới, có `CLAUDE.md`)

| File | Chạy ở | Việc |
|---|---|---|
| `search-options.ts` | cả hai | Kiểu `SearchRequest`, `SearchResponse`, `ReplaceRequest`, `ReplaceReport`, các giới hạn (`MAX_MATCHES = 20_000`, `TIME_LIMIT_MS = 30_000`, `PREVIEW_BEFORE = 26`, `PREVIEW_AFTER = 250`). |
| `search-args.ts` | host | Dựng argv cho rg: `--json --hidden --no-config --engine auto --path-separator=/`, `-F` khi không regex, `-i` khi không Match Case, `-w`, `-r` (literal: `$` → `$$`), `-g` include, `-g !` exclude, `--no-ignore` + không có thư mục loại mặc định khi tắt "Use Exclude Settings and Ignore Files". Chuyển glob kiểu VS Code sang glob rg: không có `/` → `**/x` và `**/x/**`; kết thúc `/**` giữ nguyên. Kế hoạch cho grep: danh sách file từ `git ls-files -z -co --exclude-standard` (khi bật ignore và là repo git) hoặc walk có loại thư mục, lọc include/exclude bằng `file-glob.ts`, chạy grep theo lô ≤ 24 KB argv. |
| `rg-json-parse.ts` | host | Đọc từng dòng `--json` (`match`, `begin`, `end`, `summary`), đổi offset byte → UTF-16, cắt preview quanh match, giữ `replacement` của rg. Dòng không phải UTF-8 (`lines.bytes`) được decode lossy. |
| `grep-matches.ts` | host | Với grep: tìm cột match trong dòng bằng JS (literal: `indexOf` có/không phân biệt hoa thường; regex: `RegExp` cùng pattern), tính chữ thay bằng `String.replace`. Pattern JS không dịch được → match cả dòng, không có chữ thay, `replaceUnavailable: true`. |
| `preserve-case.ts` | host | Thuật toán Preserve Case của VS Code (`buildReplaceStringWithCasePreserved`): toàn hoa, toàn thường, viết hoa chữ đầu, và theo từng đoạn `-`/`_`. |
| `search-run.ts` | host | `runSearch(projectPath, req, signal)`: chạy rg (hoặc kế hoạch grep), đếm tới 20.000 rồi dừng (`limitHit`), dừng ở 30 s (`incomplete: "timeout"`), sort theo path, áp Preserve Case, trả lỗi regex bằng chính câu của rg/grep (`regex parse error: …`) với `status: 400`. Thiếu cả rg lẫn grep → `503` với câu hiện có. |
| `replace-run.ts` | host | `runReplace(projectPath, req)`: với mỗi file, kiểm đường dẫn (realpath nằm trong project, không có đoạn `.git`/`node_modules`, `isCredentialPath` sai), đọc, kiểm từng match (`line`, `column`, `text`), thay từ cuối, ghi. Báo `replaced`, `files`, `skipped[{file, reason: "changed"}]`, `failed[{file, reason}]`. |
| `frame-codec.ts` | cả hai | `encodeFrame(kind, id, payload)` và `FrameDecoder` tăng dần: nhận chunk, trả các frame đủ dưới dạng `{kind, id, parts: Uint8Array[]}` không copy. |
| `search-host.ts` | host | `main()`: gửi `ready` (lớp chặn Windows đã được `src/index.ts` cài cho mọi mode), đọc frame từ stdin, điều phối tới `runSearch`/`runReplace`, `cancel` → abort, gzip reply khi request có `gzip: true` (`Bun.gzipSync`, ở host nên không chặn server). |
| `search-host-client.ts` | main | `getSearchHost()` singleton: `ensureStarted()`, `request(kind, payload, { signal, deadlineMs }) → Promise<{ body: Blob, gzip: boolean }>` hoặc throw `SearchHostError(status, message)`. Hook `onMainThreadTask(ms)` để test đo thời gian từng callback trên main. `stop()` cho test và lúc tắt server. |

`src/services/project-content-search.service.ts` chỉ còn `resolveProjectSearchGrep` và `resolveProjectSearchTool` (test hiện có giữ nguyên); `searchProjectContent` bị bỏ.

### Server — routes

- `GET /files/search?q&caseSensitive&wholeWord&regex&include&exclude&useIgnore&replace&preserveCase` (`src/server/routes/files.ts`): `q` rỗng → làm ấm host, trả `{results:[], total:0}`. Còn lại: dựng JSON request (`projectPath` lấy từ `c.get("projectPath")`, `gzip` theo `Accept-Encoding`), `request("search", …, { signal: c.req.raw.signal })`, trả `new Response(blob, { headers: { "Content-Type": "application/json", "Content-Encoding"?: "gzip" } })`. `gzip-json` bỏ qua response đã có `Content-Encoding`. Route gọi `server.timeout(req, 40)` qua `c.env` (Bun cắt request im lặng sau 10 s).
- `POST /files/replace` (mới): body thô `await c.req.arrayBuffer()` → `request("replace", …)` với header `projectPath` trong khung. Main không parse body.
- `src/index.ts`: `resolveEntryMode` thêm `"search"` cho `__search__` → `await import("./services/content-search/search-host.ts")`.
- `src/server/index.ts`: khi server tắt gọi `getSearchHost().stop()`.

### Browser

| File | Việc |
|---|---|
| `src/web/stores/search-store.ts` (mới) | Zustand, mỗi project một `SearchState`: `query`, `caseSensitive`, `wholeWord`, `regex`, `include`, `exclude`, `useIgnore` (mặc định true), `replace`, `preserveCase`, `showReplace`, `showDetails`, `response`, `dismissed: Set<matchKey>`, `collapsed: Set<path>`, `focusedRow`, `status`. Toàn cục: `viewMode: "list" \| "tree"` (localStorage). Lịch sử 20 query mỗi project (localStorage `ppm.search.history.<project>`). Sống ngoài component nên đổi panel hay đóng drawer không mất gì (6.5, 6.6). |
| `src/web/lib/search/search-client.ts` (mới) | Dựng URL, `AbortController` cho mỗi search, debounce 300 ms (gồm cả `replace` khi ô replace đang mở), hủy search cũ. Gọi `POST /files/replace`. |
| `src/web/lib/search/search-rows.ts` (mới) | Thuần, test được: phẳng hóa response thành row cho list hoặc tree (thư mục → file → match), đếm `N results in M files` trừ dismissed, `matchKey`, tìm match kế/trước cho F4 (vòng lại), di chuyển focus ↑↓←→, dựng `ReplaceRequest` từ các match còn lại (theo match, theo file, hoặc tất cả), và `filtersActive` cho dấu chấm trên nút ··· (include/exclude không rỗng hoặc `useIgnore` tắt). |
| `src/web/lib/open-editors-registry.ts` (mới) | Tập `project:path` đang có thay đổi chưa lưu, và hàm lấy vùng chọn của editor đang focus. `code-editor.tsx` cập nhật nó. |
| `src/web/components/explorer/search-panel.tsx` (viết lại) | Toolbar (Refresh, Clear, Collapse/Expand All, View as Tree/List), ô search có Aa/ab/.* bên trong, chevron ẩn/hiện replace, ô replace có AB + Replace All, nút ··· với include/exclude và toggle eye-off, dòng trạng thái, các banner (limit, timeout, grep, lỗi + Retry). Alt+C/W/R/P khi focus trong panel; Alt+↑/↓ (hoặc ↑/↓ khi ô trống) cho lịch sử; ↓ từ ô search vào kết quả. |
| `src/web/components/explorer/search-results.tsx` (mới) | Danh sách ảo hóa bằng `@tanstack/react-virtual` (đã có trong `package.json`), hàng 22 px desktop / 44 px phone; điều hướng bàn phím; Delete = Dismiss; Ctrl+Shift+1 = Replace. |
| `src/web/components/explorer/search-result-row.tsx` (mới) | Hàng file / thư mục / match: preview `before`·match·`after` với `…`, gạch chữ cũ + chữ mới khi có replace; nút Replace/Dismiss (match), Replace All in File/Copy Path/Dismiss (file) hiện khi hover/focus, luôn hiện trên phone (menu ··· mở bottom sheet cho hàng file). |
| `src/web/components/explorer/replace-all-dialog.tsx` (mới) | Hỏi lại với số match và số file (trừ dismissed); sau khi chạy hiện báo cáo: đã thay bao nhiêu, file bỏ qua (thay đổi chưa lưu / đã đổi trên đĩa), file lỗi + lý do. |
| `src/web/components/editor/code-editor.tsx` | Nhận `metadata.selection = { line, column, endColumn }` (UTF-16, 1-based như Monaco) và chọn đúng chữ khớp; báo trạng thái `unsaved` và vùng chọn vào `open-editors-registry`. Tab sạch tự nạp lại nội dung mới qua `file:changed` như hiện nay. |
| `src/web/hooks/use-global-keybindings.ts` + `src/web/stores/keybindings-store.ts` | `open-search` lấy vùng chọn một dòng của editor làm query (6.4). Thêm `search-next-match` (F4) và `search-prev-match` (Shift+F4), chỉ chạy khi project đang mở có kết quả. |

## Data Models

```ts
// src/services/content-search/search-options.ts
interface SearchRequest {
  projectPath: string; query: string;
  caseSensitive: boolean; wholeWord: boolean; regex: boolean;
  include: string[]; exclude: string[]; useIgnore: boolean;
  replace?: string; preserveCase?: boolean; gzip: boolean;
}
interface SearchMatch {
  line: number;          // 1-based
  column: number;        // 0-based, UTF-16, in the full line
  length: number;        // UTF-16
  before: string;        // ≤ 26 chars before the match, leading whitespace trimmed
  cutBefore: boolean;    // true → show "…" first
  text: string;          // the matched text
  after: string;         // ≤ 250 chars after
  replacement?: string;  // set when SearchRequest.replace was given and can be computed
}
interface SearchResponse {
  results: Array<{ file: string; matches: SearchMatch[] }>;   // sorted by path
  total: number; files: number;
  limitHit: boolean;                      // 20,000 reached (1.3)
  incomplete?: "timeout";                 // 30 s reached (1.4)
  engine: "rg" | "grep";
  replaceUnavailable?: boolean;           // grep + a pattern JS cannot run
}
interface ReplaceRequest {
  projectPath: string;                    // added by the route
  files: Array<{ file: string; matches: Array<{ line: number; column: number; text: string; replacement: string }> }>;
}
interface ReplaceReport {
  replaced: number; files: number;
  skipped: Array<{ file: string; reason: "changed" }>;
  failed: Array<{ file: string; reason: string }>;
}
```

- Trình duyệt bỏ các file đang có thay đổi chưa lưu ra khỏi `ReplaceRequest` và tự thêm chúng vào báo cáo với lý do `unsaved` (5.8).
- `matchKey = file + ":" + line + ":" + column`.

## Error Handling

| Trường hợp | Ai phát hiện | Trả về / hiện |
|---|---|---|
| Regex sai với engine | rg/grep stderr | `400` + câu của engine; ô search viền đỏ, câu dưới ô (3.2) |
| Pattern cần PCRE2 mà rg không có PCRE2 | rg stderr | `400` + câu của rg ("PCRE2 is not available in this build") (3.3) |
| Quá 20.000 match | host | `200`, `limitHit: true`; banner vàng, câu của VS Code (1.3) |
| Quá 30 s | host | `200`, `incomplete: "timeout"`; banner vàng + Search again (1.4) |
| Không có rg lẫn grep | host | `503`, câu hiện có + Retry |
| Host không spawn được / không `ready` trong 5 s | client main | `503` "Search could not start: …" + Retry; một `WARN` (7.5) |
| Host chết hoặc quá 35 s | client main | request đang chờ `500` "the search process exited (code n)"; host mới ở lần sau (7.6) |
| Request bị hủy (query mới, Clear) | `request.signal` | frame `cancel` → host giết rg đó; không trả gì (1.5) |
| File đổi sau khi search | `runReplace` | bỏ cả file, `skipped: changed` (5.6) |
| Ghi file lỗi / đường dẫn bị chặn | `runReplace` | `failed` + lý do; các file khác vẫn được thay (5.7) |
| File đang có thay đổi chưa lưu | trình duyệt | bỏ qua, báo `unsaved` (5.8) |

## Testing Strategy

Test chạy bằng `bun test`. Test dùng rg thật được bỏ qua khi máy không có rg (như `project-content-search.test.ts` hiện nay); test dùng grep thật chạy khi có grep. Mọi test tạo project tạm trong `mktemp`, không chạm `~/.ppm`.

Vị trí: test server trong `tests/unit/services/content-search/`, route trong `tests/unit/server/`, giao diện trong `tests/unit/web/search/`.

- **Thuần (nhanh):** `search-args.test.ts` (argv, chuyển glob, `$` literal, tắt ignore), `rg-json-parse.test.ts` (nhiều match một dòng, offset byte → UTF-16 với `é`/emoji, preview cắt quanh match, `lines.bytes`), `preserve-case.test.ts`, `frame-codec.test.ts` (frame cắt qua nhiều chunk, nhiều frame trong một chunk, không copy), `grep-matches.test.ts`, `search-rows.test.ts` (đếm trừ dismissed, list/tree, F4 vòng lại, dựng ReplaceRequest).
- **Host thật:** `search-run.test.ts` (không giới hạn 5/file, đúng `.gitignore` bật/tắt, include/exclude, Whole Word + Regex, look-around qua PCRE2, 20.000 rồi dừng, timeout trả kết quả dở với `TIME_LIMIT_MS` nhỏ, hủy giết rg), `replace-run.test.ts` (thay đúng match, `$1`, file đổi → skipped, đường dẫn ra ngoài/symlink/`.git` → failed), `search-host-client.test.ts` (spawn host thật, `ready`, crash → lỗi rồi host mới, spawn lỗi → 503 không fallback, watchdog giết host treo, **mọi callback trên main < 5 ms và số callback không tăng theo số match với fixture 20.000 match** qua `onMainThreadTask`), `search-host-imports.test.ts` (không có DB/config trong graph import).
- **Route:** `files-search-route.test.ts` (truyền tham số, gzip header, 400/503, abort hủy search, `/files/replace` chuyển body thô).
- **CLI:** `resolve-entry-mode.test.ts` thêm `__search__`.
- **Giao diện (happy-dom, như các `.test.tsx` hiện có):** `search-store.test.ts` (giữ trạng thái khi unmount, mỗi project riêng, lịch sử 20), `search-panel.test.tsx` (Alt+C/W/R/P, ↓ vào kết quả, dấu chấm ···, banner, Retry), `search-results.test.tsx` (ảo hóa: 20.000 match chỉ vẽ vài chục hàng, phím mũi tên/Enter/Delete, nút hàng hiện trên phone), `replace-all-dialog.test.tsx` (số đếm, báo cáo, file unsaved bị bỏ), `code-editor-selection.test.ts` (metadata.selection → setSelection).
- **Kiểm tay trước khi xong:** build vào thư mục scratch, chạy server scratch trên cổng lẻ, đo `Event loop stalled` trong log khi search "e" trên nxsys-workspace và khi Replace All ~1.000 match.

Bộ `suite` chỉ chạy các thư mục liên quan: chạy cả `bun test` trong một process từng bị treo và `main` có test đỏ sẵn không do spec này.

```ppm-test
task: bun test {files}
suite: bun test tests/unit/services/content-search tests/unit/services/project-content-search.test.ts tests/unit/server/files-search-route.test.ts tests/unit/cli/resolve-entry-mode.test.ts tests/unit/scripts/release-compile-entries.test.ts tests/unit/web/search
```
