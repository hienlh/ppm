# Design: Em coi PPM design bản cho android thì nên làm theo

## Overview

Giao diện vẽ sẵn ở design **PPM mobile & tablet redesign** (`designs/ppm-mobile-tablet-redesign/`, 16 trang), và đó chính là bản vẽ của spec. Task gọi màn hình bằng `_Screen:` với tên trang như trang mục lục của design ghi (`Phone 4 · Git & Terminal`, `Tablet 2 · Shell`, `Foundation`, …).

Hướng làm:
- **Giữ nguyên phần lõi của app** (`core/protocol`, `core/client`, `core/state`): socket, REST, reducer của chat, layout workspace đều đã port từ web và đã có test. Việc mới gần như toàn bộ nằm ở tầng giao diện.
- **Phone làm lại từ khung**: một `PhoneShell` mới theo mô hình ☰ drawer + tiêu đề = tab switcher + thẻ hành động dưới đáy, thay cho `PhoneShell.kt` hiện tại (bản sao giao diện mobile của web).
- **Tablet giữ khung hiện có** (`ui/tablet/*`: panel, dock, tab, sidebar, status bar) và vẽ lại từng màn theo Tablet 1–7.
- **Ba thay đổi phía server PPM**: danh sách thông báo có lưu trạng thái đọc (kèm lượt chạy schedule), endpoint viết commit message bằng AI, và payload push có thêm `kind` để app chia kênh.
- **Push qua UnifiedPush** dùng lại Web Push sẵn có của PPM, không cần máy trung gian (lý do ở mục Push).
- **Làm dần mà app vẫn dùng được**: giao diện mới nằm sau một công tắc cục bộ, cho đến khi đủ màn thì bật mặc định và xóa giao diện phone cũ.

Hai repo:
- `~/Projects/ppm`: server (notification feed, commit message, push payload).
- `~/Projects/ppm-android`: app. Commit local; hỏi trước khi push.

Trước khi bắt đầu, gộp các nhánh còn treo (`agy/antigravity-ui`, `agy/tablet-parity`, đã thử chung ở `try/261110-antigravity-tablet`) vào `main` của app, để mọi task cùng đi từ một chỗ.

## Architecture

```
ppm (server)                                   ppm-android (app)
────────────────────────────                   ─────────────────────────────────────────────
notification.service ──record──▶ notification_feed (SQLite)
        │                          │  GET/POST /api/notifications/feed*  ◀── core/client: ApiClientFeed
        │                          └─ notifications:feed_changed (/ws/global) ◀── core/state: GlobalEvents
        └─ web-push.service ── aes128gcm ──▶ UnifiedPush endpoint ──▶ app: PushReceiver ─▶ NotificationChannels
git routes: POST /git/commit-message ◀──────────────── core/client: ApiClientGit.commitMessage
                                                       core/state:  GitChangeGroups, NotificationFeed
                                                       ui/design:   kit/* (AppBar, Drawer, BottomCard, Sheet, …)
                                                       app/ui:      SizeClass → PhoneShell (mới) | TabletShell
```

**Chọn layout.** `SizeClass.of(widthDp)`: dưới 600 dp là `Phone`, còn lại là `Tablet`. `Root.kt` hiện chọn theo cờ `mobile`; cờ này được thay bằng `SizeClass`. Khi đổi cỡ, `Root` chỉ đổi shell. Project, tab, nháp chat đã nằm trong `WorkspaceStore`/`ChatController` (ngoài shell), nên không mất. Vị trí cuộn của màn đang mở giữ bằng `rememberSaveable` theo id tab.

**Công tắc giao diện mới.** `LocalPrefs.redesign` (mặc định tắt, nằm trong Settings → About khi build debug). Tắt: `PhoneShell` cũ, tablet như hiện tại. Bật: `PhoneShell` mới, và các màn tablet đã vẽ lại. Task cuối bật mặc định, xóa `PhoneShell` cũ và xóa công tắc.

**Điều hướng phone (`PhoneNav`).** Một state holder giữ: drawer mở/đóng, chồng sheet, lịch sử tab đã xem. Thứ tự của nút Back (2.5) nằm ở một hàm `PhoneNav.back(): BackResult`:
1. sheet trên cùng;
2. drawer;
3. tab trước đó;
4. nếu không còn gì thì `Exit`.

Màn hình chính chọn theo loại tab:
- Loại tab phone có → màn phone tương ứng.
- Loại tab chỉ tablet có → `OpenOnTablet`, một dòng thông báo (3.2).
- Tab vẫn nằm nguyên trong `WorkspaceStore`, không bị xóa (3.3).

**Bộ component (`ui/design/kit`).** Dựng một lần theo Foundation, mọi màn dùng chung:
- `AppBar` (☰, tiêu đề bấm được, tối đa 2 action);
- `PhoneDrawer`;
- `TabSwitcherSheet`;
- `BottomActionCard` (nằm trên thanh điều hướng hệ thống và trên bàn phím: `imePadding` + `navigationBarsPadding`);
- `ListRow` (có long-press sheet, swipe action, và chuột phải mở cùng menu);
- `Sheet` (bottom sheet trên phone, side sheet trên tablet);
- `Chip`;
- `ConfirmDialog`;
- `UndoBar` (đếm 8 s);
- `NeedsYouPill`;
- `KeyRow`;
- `SplitPane`;
- `HoverTooltip`.

Token màu, chữ, bo góc lấy từ `Themes.generated.kt` (cùng nguồn `tokens.css` với design). Cỡ chạm tối thiểu 48 dp là hằng số trong kit, không đặt lẻ từng màn.

**Mapping màn hình → code có sẵn**

| Screen | Dùng lại | Mới |
|---|---|---|
| Phone 1 · Chat | `ui/chat` (transcript, card, composer logic), `ChatController` | Bố cục phone: composer trong `BottomActionCard`, `NeedsYouPill`, history nhóm theo ngày + swipe |
| Tablet 1 · Chat | `ui/chat`, `PanelGrid` | Navigator luôn hiện, chat cạnh editor/terminal bằng panel có sẵn |
| Phone 2 · Projects | `ServerStore`, flow connect, project API | Drawer project switcher, sheet thêm/clone/đổi tên/màu/xóa, xác nhận xóa, cảnh báo HTTP, màn offline, onboarding |
| Tablet 2 · Shell | `TabletShell`, `Sidebar`, `TabBar`, `StatusBar`, palette | Vẽ lại theo Tablet 2; danh sách thông báo mới |
| Phone/Tablet 3 · Files | `app/ui/files`, viewer có sẵn | PDF từng trang (`PdfRenderer`); Replace All có xác nhận; OS Explorer mở thành tab |
| Phone 4 · Git & Terminal | `app/ui/git`, `ui/terminal` | `GitChangeGroups`, Discard file + Undo, Write with AI, `KeyRow`, mở terminal của AI với lệnh gõ sẵn |
| Tablet 4 · Git & Terminal | `app/ui/git`, Git Graph webview, `Dock` | Vẽ lại; Staged/Changes cũng dùng `GitChangeGroups` |
| Phone 5 · Database | `app/ui/database` | Chế độ chỉ đọc: không render control ghi (`readOnly = true`) |
| Tablet 5 · Database | `app/ui/database` | Vẽ lại theo Tablet 5 |
| Phone 6 / Tablet 6 · Settings | các section có sẵn | Phone: 6 section đầy đủ + dòng "Open on a tablet"; tablet: list-detail |
| Phone 7 · Tools | Monitor, Logs, Ports, Cloud & Share có sẵn | Schedules thành trang Settings với thẻ hành động; Cloud & Share thành ô trong drawer |
| Tablet 7 · Tools | các tool có sẵn | Remote Desktop, Logs, OS Explorer mở thành tab, không phải cửa sổ nổi |

**Bàn phím và chuột trên tablet.** Đã có: phím tắt (E2), hover (E5), focus ring (99c/d). Phần mới:
- mọi `ListRow` nhận chuột phải;
- tooltip theo `HoverTooltip`;
- Escape đóng lớp trên cùng qua chính `PhoneNav`/`TabletNav.back()`;
- quy tắc 16.4: không control nào chỉ đến được bằng hover.

## Components and Interfaces

### Server (`~/Projects/ppm`)

**Notification feed** — `src/services/notification-feed.service.ts`
```ts
record(e: { kind: FeedKind; projectName: string; sessionId?: string; scheduleId?: string; title: string; body: string }): FeedRow
list(opts: { limit?: number; before?: number }): { rows: FeedRow[]; hasMore: boolean }
setRead(id: number, read: boolean): FeedRow
markSessionRead(sessionId: string): void      // gọi từ route /sessions/:id/read có sẵn
readAll(): void                                // Clear all của web = readAll
prune(): void                                  // giữ 500 dòng / 30 ngày
```
- `notification.service.deliver` gọi `record` mỗi khi gửi một thông báo. Schedule đi qua đây sẵn nên lượt chạy có mặt trong feed (6.3).
- Mỗi thay đổi phát `notifications:feed_changed` trên `/ws/global`; mọi thiết bị cập nhật theo (6.2).
- Route (`src/server/routes/notifications.ts`):
  - `GET /api/notifications/feed?limit=&before=`
  - `POST /api/notifications/feed/:id/read`
  - `POST /api/notifications/feed/:id/unread`
  - `POST /api/notifications/feed/read-all`
- Web không đổi giao diện trong spec này. Unread theo session vẫn chạy như cũ; mở một session thì các dòng feed của session đó thành đã đọc.

**Commit message** — `src/services/git-commit-message.service.ts`, route `POST /api/projects/:name/git/commit-message` (có `?repo=` như mọi route git)
```ts
generate(repoPath: string): Promise<{ message: string }>
// 409 "Nothing is staged" khi diff --cached rỗng; 502 kèm lỗi của provider khi gọi AI thất bại
```
- Lấy `git diff --cached --stat` + `git diff --cached`. Diff dài quá 60 KB thì cắt, gửi kèm danh sách file.
- Gọi `completeOnce` với model nhẹ của provider mặc định, như `ctx-ask.ts` làm.
- Chỉ trả về chữ, không bao giờ commit (10.3).
- Web dùng lại endpoint này ở Phase 2 của plan web (10.6).

**Push payload** — `src/shared/web-push-payload.ts`: thêm `kind: "approval" | "question" | "done" | "schedule" | "other"` (field mới, service worker của web bỏ qua). `notification.service` điền từ loại sự kiện.

### App (`~/Projects/ppm-android`)

**core/client**
- `ApiClientFeed`: `feed(limit, before)`, `setRead(id, read)`, `readAll()`. Server trả 404 → `FeedUnsupported` (6.4).
- `ApiClientGit.commitMessage(project, repo): Result<String>`.
- `ApiClientPush.subscribe(endpoint, p256dh, auth, label = "Android · <device>", origin = server URL)` gọi `/api/notifications/push/subscribe` có sẵn.

**core/state**
- `GitChangeGroups.from(status): { staged: List<FileChange>; changes: List<FileChange> }`: file vừa có phần đã stage vừa có phần chưa stage nằm ở cả hai nhóm (9.1). Hàm thuần, test trên JVM.
- `NotificationFeed`: StateFlow các dòng; nghe `notifications:feed_changed`. Khi `FeedUnsupported` thì dùng danh sách unread theo session hiện có.
- `AddressSafety.classify(url): Loopback | Private | Tailscale | Public`; cảnh báo khi `Public` + `http` (5.2).
- `Connectivity`: `NetworkCallback`, phân biệt "máy không có mạng" với "server không trả lời" (5.3).

**app/ui**
- `SizeClass`, `PhoneNav`, `PhoneShell` (mới), `OpenOnTablet`.
- Các màn phone trong `app/ui/phone/*`, các màn tablet trong `app/ui/tablet/*`.
- Write with AI: nút trong ô commit; state `Idle | Writing | Written | Failed(msg)`; Commit bị khóa khi `Writing`; chữ người dùng gõ được giữ khi `Failed` (10.2–10.5).
- Discard file (9.4): `ConfirmDialog` → `POST /git/discard` có sẵn → `UndoBar` 8 s → `POST /git/discard/undo { id }` (server đã giữ bản cũ trong discard journal).
- Lệnh AI gõ vào terminal (12.2): thẻ trong chat mở màn Terminal trên terminal mới của AI. Server đã gõ sẵn lệnh và chưa chạy; app chỉ đổi tab, không gửi gì thêm.
- PDF: `android.graphics.pdf.PdfRenderer` render từng trang thành bitmap, lazy theo trang.

**Push (`app/push`)**
- `UnifiedPushReceiver` (thư viện connector của UnifiedPush) nhận endpoint và key, gửi lên server bằng `ApiClientPush.subscribe`.
- Khi có message, giải mã (connector làm), đọc `WebPushPayload`, hiện lên `NotificationChannels` theo `kind`.
- Bấm thông báo → deep link `ppm://` có sẵn (E3c), mở đúng session (7.2).
- Quyền `POST_NOTIFICATIONS` chỉ xin khi bật công tắc trong Settings → Notifications (7.3).

## Data Models

```sql
-- migration mới trong db.service.ts; tăng CURRENT_SCHEMA_VERSION theo
CREATE TABLE notification_feed (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,          -- approval | question | done | schedule | other
  project     TEXT NOT NULL DEFAULT '',
  session_id  TEXT,
  schedule_id TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,       -- ms
  read_at     INTEGER                 -- NULL = chưa đọc
);
CREATE INDEX notification_feed_created ON notification_feed(created_at DESC);
CREATE INDEX notification_feed_session ON notification_feed(session_id) WHERE session_id IS NOT NULL;
```

```ts
interface FeedRow { id: number; kind: FeedKind; project: string; sessionId: string | null;
  scheduleId: string | null; title: string; body: string; createdAt: number; read: boolean }
interface CommitMessageResponse { message: string }
interface WebPushPayload { /* field có sẵn */ kind?: FeedKind }
```

Phía app:
- `sealed interface SizeClass { Phone; Tablet }`
- `data class PhoneNavState(drawer: Boolean, sheets: List<SheetKey>, history: List<TabId>)`
- `enum PhoneArea` (danh sách đóng các vùng phone có, 3.1)
- `data class GitChangeGroups(staged, changes)`
- `sealed interface WriteWithAi`

## Error Handling

- **Server cũ, thiếu route mới.**
  - Feed 404 → dùng danh sách unread theo session cũ (6.4).
  - `commit-message` 404 → ẩn nút Write with AI.
  - Payload không có `kind` → kênh "Other".
- **Write with AI.**
  - 409 → nút bị khóa, kèm dòng "Stage changes first" (10.4).
  - 502 hoặc mạng lỗi → `Failed` với Retry, giữ nguyên chữ người dùng đã gõ (10.5).
- **Discard + Undo.** Undo trả 409 (file đã đổi sau đó) → báo "The file changed since, so Undo would overwrite it", giống web.
- **Mất mạng.** `Connectivity` báo không có mạng → màn "This phone is offline" và tự thử lại khi có mạng; có mạng mà server không trả lời → lỗi server như hiện tại (5.3).
- **Mật khẩu qua HTTP.** Địa chỉ `Public` + `http` → `ConfirmDialog` trước khi gửi; người dùng hủy thì không gửi gì (5.2).
- **Push.** Chưa có distributor nào (không cài ntfy, máy không có Google Play) → Settings → Notifications nói rõ cần cài gì, công tắc không bật được. Người dùng từ chối quyền → công tắc tự tắt lại và chỉ đường vào cài đặt hệ thống.
- **Tính năng chỉ tablet có, bị mở trên phone** (deep link, thông báo) → `OpenOnTablet`, không crash, không xóa tab (3.2, 3.3).

## Testing Strategy

- **Server (`bun test`, `PPM_HOME` tạm):**
  - feed: record, list, read/unread, read-all, prune, event phát ra, session read kéo theo feed read;
  - migration (cuối ở `CURRENT_SCHEMA_VERSION`);
  - `commit-message` với `completeOnce` giả: 409 khi chưa stage, cắt diff dài, không gọi `git commit`;
  - payload có `kind`.
- **App, JVM** (`./gradlew :core:client:test :core:state:test :app:testDebugUnitTest`):
  - `SizeClass` ở 599/600 dp;
  - thứ tự `PhoneNav.back()`;
  - `GitChangeGroups` với file stage một phần;
  - `AddressSafety` (loopback, 10/8, 172.16/12, 192.168/16, 100.64/10, public, https);
  - `NotificationFeed` khi server không hỗ trợ;
  - state machine của Write with AI;
  - đếm giờ của Undo.
- **So với bản vẽ (17.1):** mỗi task làm màn hình chụp màn đó trên `emulator-5580` (phone 412×915) và `emulator-5582` (tablet 1280×800), đặt cạnh frame tương ứng của design chụp bằng Playwright cùng cỡ, đo sai lệch theo px. Dữ liệu từ scratch server và fixture-proxy có sẵn (`~/.local/share/ppm-e4b/fixtures`); chỉ gửi tin vào session mock.
- **Push end-to-end:** spike đầu tiên chứng minh `web-push.service` của PPM gửi tới endpoint UnifiedPush (ntfy làm distributor trên emulator) và app hiện đúng kênh. Không qua được thì dừng phần push và hỏi anh trước khi chọn cách khác.
- **Kiểm tra tay trên máy thật:** chỉ chạy test trên LG V40 như đã cho phép; không cài lên tablet của anh khi anh chưa bảo.
- **Suite bỏ test cần internet:** lệnh suite chạy với `PPM_SKIP_LIVE=1`, bỏ 8 file test cần mạng thật (tunnel Cloudflare thật, ...). Trong cả suite, trycloudflare trả 429 vì tạo tunnel quá dày, nên các test đó hỏng mà không liên quan code của task.
- **Suite bỏ test của spec Search:** spec Search chạy cùng lúc trong thư mục ppm theo kiểu Thorough, nên test đỏ của nó (`tests/unit/services/content-search/`, `tests/unit/web/search/`) có mặt trong suite khi task của nó đang viết dở. Task còn lại của spec này chỉ sửa `../ppm-android`, nên lệnh suite bỏ hai thư mục đó.

<!-- Thorough mode runs exactly these commands, from the project folder, after you approve this file.
     {files} becomes the task's _Test:_ files. -->
```ppm-test
task: bun test {files}
suite: PPM_SKIP_LIVE=1 bun test --path-ignore-patterns='tests/unit/services/content-search/**' --path-ignore-patterns='tests/unit/web/search/**'
```
