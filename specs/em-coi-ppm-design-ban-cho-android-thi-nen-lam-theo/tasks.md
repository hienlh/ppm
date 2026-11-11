# Implementation Plan: Em coi PPM design bản cho android thì nên làm theo

<!-- One checkbox per task. Under each, the lines PPM reads:
       _Requirements: 1.1, 1.2_   which acceptance criteria it implements
       _Deps: 1_                  tasks that must finish first (tasks without deps run in parallel)
       _Files: src/a.ts, src/b.ts_ every file it will create or change (tasks sharing a file never run together)
       _Test: tests/a.test.ts_     its test files (Thorough: they must fail first, then pass)
       _Test: none — reason_       when a task cannot have a test
     Mark an optional task with an asterisk: - [ ]* 4. Title -->

Ghi chú chung:
- Task 1–3 sửa server PPM (repo này); test chạy bằng `bun test`, PPM tự chấm đỏ/xanh.
- Task 4 trở đi sửa app Android ở `../ppm-android` (`~/Projects/ppm-android`). Test của app là test JVM chạy bằng Gradle trong repo đó; lệnh test của spec (`bun test`) không chạy được chúng. Vì vậy các task này ghi `_Test: none_`, nhưng mỗi task vẫn phải viết test JVM có ghi tên và chạy xanh trước khi `task_done`, và ghi lệnh Gradle đã chạy vào tóm tắt.
- App: commit local theo từng task, không push khi anh chưa bảo. Chỉ gửi tin vào session mock; không cài lên tablet của anh.
- Task làm màn hình ghi `_Screen:_` là tên một trang của bản vẽ `designs/ppm-mobile-tablet-redesign/` (Foundation, Phone 1–7, Tablet 1–7).
- Trang Phone còn có khung tablet (T1–T4) và phần "Not on a phone" / "Drawn for a phone, now tablet-only": các phần đó thuộc task tablet cùng vùng (12, 15, 16, 17, 19), không thuộc task phone.

- [x] 1. Server: danh sách thông báo lưu trạng thái đọc
  - Bảng `notification_feed` (migration mới, tăng `CURRENT_SCHEMA_VERSION`), service `record / list / setRead / markSessionRead / readAll / prune`, ghi một dòng mỗi khi `notification.service` gửi đi (lượt chạy schedule cũng vậy), route `GET /api/notifications/feed`, `POST …/feed/:id/read|unread`, `POST …/feed/read-all`, sự kiện `notifications:feed_changed` trên `/ws/global`, và route `/chat/sessions/:id/read` có sẵn đánh dấu các dòng của session đó là đã đọc.
  - _Requirements: 6.1, 6.2, 6.3_
  - _Files: src/services/notification-feed.service.ts, src/shared/notification-feed.ts, src/services/db.service.ts, src/services/notification.service.ts, src/server/routes/notifications.ts, src/server/routes/chat.ts, tests/unit/services/notification-feed.test.ts, tests/integration/api/notification-feed-routes.test.ts_
  - _Test: tests/unit/services/notification-feed.test.ts, tests/integration/api/notification-feed-routes.test.ts_

- [x] 2. Server: endpoint viết commit message bằng AI
  - `POST /api/projects/:name/git/commit-message` (nhận `?repo=`): đọc `git diff --cached --stat` + diff (cắt ở 60 KB, kèm danh sách file), gọi `completeOnce` với model nhẹ của provider mặc định, trả `{ message }`; 409 khi chưa stage gì, 502 khi AI lỗi; không bao giờ commit.
  - _Requirements: 10.1, 10.3, 10.4, 10.6_
  - _Files: src/services/git-commit-message.service.ts, src/server/routes/git.ts, tests/unit/services/git-commit-message.test.ts_
  - _Test: tests/unit/services/git-commit-message.test.ts_

- [x] 3. Server: push mang theo loại thông báo
  - Thêm `kind` (`approval | question | done | schedule | other`) vào `WebPushPayload`, `notification.service` điền theo loại sự kiện; service worker của web bỏ qua field mới.
  - _Requirements: 7.1_
  - _Deps: 1_
  - _Files: src/shared/web-push-payload.ts, src/services/web-push/web-push.service.ts, src/services/notification.service.ts, tests/unit/services/web-push-payload-kind.test.ts_
  - _Test: tests/unit/services/web-push-payload-kind.test.ts_

- [x] 4. App: gộp các nhánh còn treo vào main
  - Gộp `agy/antigravity-ui` và `agy/tablet-parity` vào `main` (như đã thử ở `try/261110-antigravity-tablet`), xử lý xung đột như lần thử, suite JVM xanh, build release chạy được trên scratch server. Không push.
  - _Requirements: 17.2_
  - _Files: ../ppm-android/_
  - _Test: none — chỉ gộp nhánh; chạy `./gradlew test` trong ../ppm-android_

- [x] 5. App: cỡ màn hình, bộ component và công tắc giao diện mới
  - `SizeClass` (600 dp), `Root.kt` chọn shell theo `SizeClass` và giữ trạng thái khi đổi cỡ; công tắc `redesign` trong prefs; bộ `ui/design/kit` theo Foundation (AppBar, PhoneDrawer, TabSwitcherSheet, BottomActionCard, ListRow có long-press + swipe + chuột phải, Sheet, Chip, ConfirmDialog, UndoBar, NeedsYouPill, KeyRow, SplitPane, HoverTooltip), cỡ chạm 48 dp. Test JVM: `SizeClassTest`, `UndoBarTimerTest`.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 16.1, 16.2_
  - _Deps: 4_
  - _Files: ../ppm-android/ui/design/src/main/kotlin/com/hienlh/ppm/design/kit/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/SizeClass.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/Root.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/Storage.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Foundation_

- [x] 6. App: khung phone và điều hướng
  - `PhoneShell` mới (☰, tiêu đề mở tab switcher, thẻ hành động dưới đáy, không có thanh tab dưới), `PhoneNav` với thứ tự Back, `PhoneArea` (những vùng phone có), `OpenOnTablet` cho tab chỉ tablet có mà không xóa tab khỏi layout. Test JVM: `PhoneNavBackTest`, `PhoneAreaTest`.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3_
  - _Deps: 5_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/PhoneShell.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/PhoneNav.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/OpenOnTablet.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Foundation_

- [x] 7. App: Chat trên phone
  - Theo từng mục của Phone 1: new chat (chọn provider, model, effort, permission), tin nhắn, tool card, card chờ anh trả lời, composer trong thẻ dưới đáy, các thanh trên composer và thứ chúng mở, lịch sử chat, Session debug và Session info, phần Spec additions; `NeedsYouPill` khi có card đang chờ ngoài màn hình; lịch sử nhóm theo ngày, vuốt một dòng để hiện hành động. Test JVM: `HistoryByDayTest`, `NeedsYouTest`.
  - _Requirements: 4.1, 4.2, 4.3_
  - _Deps: 6_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/chat/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/SessionHistory.kt, ../ppm-android/core/state/src/main/kotlin/com/hienlh/ppm/state/ChatAttention.kt, ../ppm-android/ui/chat/src/main/kotlin/com/hienlh/ppm/chat/SessionDebug.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 1 · Chat_

- [x] 8. App: Chat trên tablet
  - Vẽ lại theo từng mục của Tablet 1: chat trong khung tablet, new chat và các picker, tin nhắn, tool card, card chờ trả lời, composer (đính kèm, picker @ và /, turn reference, voice), chip ở footer và popover của chúng, các thanh và lệnh chạy nền, transcript của subagent, lịch sử và history window, Session debug và Session info, nhiều chat cạnh nhau và chat cạnh editor hoặc terminal; navigator tin nhắn luôn hiện, agent dock. Bỏ qua mục iPad.
  - _Requirements: 4.1, 4.4, 4.5_
  - _Deps: 5_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/ChatPane.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/tablet/PanelGrid.kt, ../ppm-android/ui/chat/src/main/kotlin/com/hienlh/ppm/chat/ChatTranscriptView.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Tablet 1 · Chat_

- [x] 9. App: kết nối server, project và onboarding
  - Flow kết nối và danh sách server, `AddressSafety` (cảnh báo mật khẩu qua HTTP ra địa chỉ public), `Connectivity` và các trạng thái cấp app của Phone 2 / Tablet 2 (Server Unreachable, Connection Lost, Domain Not Responding, "This phone is offline", đang cập nhật), sheet project (chuyển, thêm một thư mục trên server, clone, đổi tên, đổi màu, xóa có hỏi lại), project không có git và project chứa nhiều repository, server tự cập nhật (`UpgradeButton`), app tự cập nhật (`AppUpdater`), onboarding lần đầu, tour nhanh và bước "PPM has new features" (`/api/feature-intros`). Tablet: cùng các danh sách đó trong card neo, nhiều server trong project switcher, cập nhật server từ status bar (Tablet 2). Test JVM: `AddressSafetyTest`, `ConnectivityStateTest`.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - _Deps: 6_
  - _Files: ../ppm-android/core/state/src/main/kotlin/com/hienlh/ppm/state/AddressSafety.kt, ../ppm-android/core/state/src/main/kotlin/com/hienlh/ppm/state/Connectivity.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/ConnectScreen.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/ConnectionLostOverlay.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/projects/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/onboarding/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/UpgradeButton.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/update/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 2 · Server, projects, notifications, Tablet 2 · Shell, projects, palette, notifications_

- [x] 10. App: danh sách thông báo
  - `ApiClientFeed`, `NotificationFeed` (nghe `notifications:feed_changed`, quay về danh sách unread theo session khi server trả 404), danh sách trên phone (NT1–NT3: "All caught up", hành động của một dòng) và card thông báo trên tablet (TN1, Tablet 2 mục 8) với đánh dấu đã đọc/chưa đọc từng dòng và lượt chạy schedule. Test JVM: `NotificationFeedTest` (cả trường hợp server cũ).
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Deps: 1, 6_
  - _Files: ../ppm-android/core/client/src/main/kotlin/com/hienlh/ppm/client/ApiClientFeed.kt, ../ppm-android/core/state/src/main/kotlin/com/hienlh/ppm/state/NotificationFeed.kt, ../ppm-android/core/state/src/main/kotlin/com/hienlh/ppm/state/GlobalEvents.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/tablet/NotificationBell.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/notifications/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 2 · Server, projects, notifications_

- [x] 11. App: Files trên phone và xem PDF từng trang
  - Theo Phone 3: cây file, editor (xem code, sửa nhỏ và Save), diff của file, các viewer (ảnh, Markdown, file phone không hiện được); PDF hiện từng trang bằng `PdfRenderer` (dùng cho cả tablet).
  - _Requirements: 8.1, 8.2_
  - _Deps: 6_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/files/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/files/PdfPages.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 3 · Files_

- [x] 12. App: Files, editor và tìm kiếm trên tablet
  - Vẽ lại theo từng mục của Tablet 3: cây file, editor, diff và compare, viewer, search & replace, OS File Explorer, phím tắt và thao tác chạm tương ứng; Replace All nói rõ bao nhiêu chỗ trong bao nhiêu file và chỉ thay sau khi xác nhận; OS File Explorer mở thành tab. Test JVM: `ReplaceAllConfirmTest`.
  - _Requirements: 8.3, 8.4, 8.5_
  - _Deps: 5, 11_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/files/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/osexplorer/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/windows/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Tablet 3 · Files, editor, search_

- [x] 13. App: Source Control trên phone
  - `GitChangeGroups` (file stage một phần nằm ở cả hai nhóm), danh sách Staged/Changes, diff, stage/unstage cả file, "Discard changes…" có hỏi lại + Undo 8 s qua `/git/discard/undo`, commit, push, pull, đổi nhánh; không có tính năng chỉ tablet. Test JVM: `GitChangeGroupsTest`, `DiscardUndoTest`.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - _Deps: 6_
  - _Files: ../ppm-android/core/state/src/main/kotlin/com/hienlh/ppm/state/git/GitChangeGroups.kt, ../ppm-android/core/client/src/main/kotlin/com/hienlh/ppm/client/ApiClientGit.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/git/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 4 · Source Control & Terminal_

- [x] 14. App: Write with AI
  - Nút trong ô commit trên phone và tablet, state `Idle | Writing | Written | Failed`, khóa Commit khi đang viết, giữ chữ đã gõ khi lỗi và có Retry, khóa nút kèm lý do khi chưa stage gì, ẩn nút khi server không có endpoint. Test JVM: `WriteWithAiTest`.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_
  - _Deps: 2, 13_
  - _Files: ../ppm-android/core/state/src/main/kotlin/com/hienlh/ppm/state/git/WriteWithAi.kt, ../ppm-android/core/client/src/main/kotlin/com/hienlh/ppm/client/ApiClientGit.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/git/CommitBox.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 4 · Source Control & Terminal_

- [x] 15. App: Source Control và Git Graph trên tablet
  - Vẽ lại theo Tablet 4 (mục 1–7 và 10): Staged/Changes dùng `GitChangeGroups`, stage và discard theo khối/dòng, Discard all, Review changes, nhánh, sync, stash, worktree, conflict và conflict editor, Git Graph (menu, dialog, thao tác), blame, chọn repository, phím tắt và thao tác chạm tương ứng.
  - _Requirements: 11.1, 11.2_
  - _Deps: 5, 13_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/git/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Tablet 4 · Source Control, Git Graph, Terminal_

- [x] 16. App: Terminal
  - Phone: một terminal với hàng phím (`KeyRow`), cả khi xoay ngang 915 × 412 (Phone 4); thẻ lệnh AI trong chat mở terminal của AI với lệnh đã gõ sẵn, chưa chạy. Tablet: nhiều terminal, dock ở mọi vị trí, chia đôi, trạng thái kết nối và link theo Tablet 4 mục 8.
  - _Requirements: 12.1, 12.2, 12.3_
  - _Deps: 6_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/TerminalBody.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/TerminalMobileToolbar.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/tablet/Dock.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/terminal/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 4 · Source Control & Terminal_

- [x] 17. App: Database
  - Phone: kết nối, schema browser (database, bảng, cột), xem dòng, đọc query, không có control nào ghi (`readOnly`). Tablet: vẽ lại theo từng mục của Tablet 5: kết nối, connection form, schema browser, data grid và sửa dữ liệu, filter và sort, form view, cell data và reference, structure, table operations, Query, Write access once, Export và tab Import/Export, phím tắt. Cả hai: thẻ công cụ database của AI trong chat (`db_query`, `open_query`, `db_execute`) theo phần "The AI's database tools". Test JVM: `DatabaseReadOnlyTest` (không action ghi nào được hiện khi `readOnly`).
  - _Requirements: 13.1, 13.2_
  - _Deps: 6_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/database/, ../ppm-android/ui/chat/src/main/kotlin/com/hienlh/ppm/chat/PpmToolCalls.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 5 · Database, Tablet 5 · Database_

- [x] 18. App: Settings
  - Phone theo Phone 6: danh sách settings, các mẫu control, AI Provider, Accounts (đăng nhập, usage, chuyển, gỡ), About, Appearance và Servers, Notifications; các mục khác là một dòng "Open on a tablet". Tablet theo Tablet 6, dạng list-detail: General & About (mật khẩu, cập nhật), Appearance, Editor (language server, file filter), AI Provider, Tools & session collaboration, Accounts (rotation), Design & Voice Input, Notifications (push, Telegram, ntfy), Remote Access, Scheduled Agents, Extensions / PPMBot / API Proxy / Jira Watcher, Keyboard Shortcuts, Remote Desktop & Database Drivers, Storage & backups.
  - _Requirements: 15.1, 15.2, 15.3_
  - _Deps: 6_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/Settings.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/settings/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 6 · Settings, Tablet 6 · Settings_

- [x] 19. App: công cụ
  - Phone: Monitor, Logs, Port forwarding, ô Cloud & Share trong drawer, Schedules thành trang Settings (bật/tắt, chạy ngay, đọc log, nút chính ở thẻ dưới đáy, không sửa script). Tablet theo Tablet 7: Monitor, Logs, Port Forwarding và tunnel, Cloud & Share, Remote Desktop, Android device, Extensions và panel của chúng, Designs (canvas, comment, share, version), Schedules (danh sách, editor script, lượt chạy, log), Teams, Jira; Remote Desktop và Logs mở thành tab.
  - _Requirements: 14.1, 14.2, 14.3, 14.4_
  - _Deps: 6, 18_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/sysmon/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/logs/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/tunnels/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/remotedesktop/, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/tools/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 7 · Tools, Tablet 7 · Tools_

- [x] 20. App: push notification
  - Trước hết thử thật: `web-push.service` của PPM gửi tới endpoint UnifiedPush (ntfy làm distributor trên emulator) và app nhận được; không qua được thì dừng task và hỏi anh. Sau đó: `UnifiedPushReceiver`, đăng ký qua `/api/notifications/push/subscribe`, kênh Android theo `kind`, bấm mở đúng session, xin quyền chỉ khi bật công tắc trong Settings → Notifications, báo rõ khi máy không có distributor. Test JVM: `PushPayloadRoutingTest`.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - _Deps: 3, 18_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/push/, ../ppm-android/app/src/main/AndroidManifest.xml, ../ppm-android/app/build.gradle.kts, ../ppm-android/core/client/src/main/kotlin/com/hienlh/ppm/client/ApiClientPush.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/settings/NotificationsPage.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Phone 6 · Settings_

- [x] 21. App: khung tablet, bàn phím và chuột
  - Vẽ lại theo Tablet 2 (mục 3–7): rail và sidebar, tab và split, status bar (từng mục), floating window và window dock, command palette mọi mode (phone không có palette); Escape đóng lớp trên cùng, focus ring và thứ tự Tab theo Foundation, phím tắt của web; rà để mọi hành động đến được bằng tay không cần hover, chuột phải hay bàn phím.
  - _Requirements: 16.3, 16.4_
  - _Deps: 5_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/tablet/TabletShell.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/tablet/Sidebar.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/tablet/TabBar.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/tablet/StatusBar.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/CommandPalette.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/KeyboardShortcuts.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/windows/_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Tablet 2 · Shell, projects, palette, notifications_

- [x] 22. App: so từng màn với bản vẽ
  - Chụp mỗi màn trên `emulator-5580` (412 × 915) và `emulator-5582` (1280 × 800), đặt cạnh frame tương ứng của design chụp bằng Playwright cùng cỡ, đo sai lệch và sửa, cả theme sáng lẫn Aurora Dark (Foundation mục 6); ghi các chỗ app theo logic web khác bản vẽ.
  - _Requirements: 17.1, 17.2_
  - _Deps: 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 24_
  - _Files: ../ppm-android/shots/redesign/_
  - _Test: none — kiểm tra bằng ảnh chụp, không phải test tự động_

- [x] 23. App: bật giao diện mới mặc định, bỏ giao diện phone cũ
  - Bật `redesign` mặc định, xóa `PhoneShell.kt` cũ và công tắc, suite JVM xanh, build release chạy được trên scratch server.
  - _Requirements: 1.1, 1.2_
  - _Deps: 22_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/PhoneShell.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/Root.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/Storage.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_

- [x] 24. App: nối các màn phone vào PhoneShell và dữ liệu thật
  - Các task 7, 9, 10, 11, 13, 16, 19 viết màn phone riêng nhưng không được sửa `PhoneShell.kt`, nên khung phone mới vẫn hiện nội dung cũ. Task này nối từng vùng của `PhoneShell` vào màn mới với dữ liệu thật từ `AppModel`: Chat → `PhoneChatScreen` (session đang mở, composer, approval, model/effort/permission, history theo ngày), Files → `PhoneFilesTreeScreen` + editor/diff/viewer, Source Control → `PhoneSourceControlScreen` (kèm Write with AI của task 14), Terminal → màn terminal phone của task 16, Monitor/Logs/Port forwarding/Schedules/Cloud & Share → màn của task 19, Database → body read-only của task 17; drawer mở `ProjectSwitcherSheet` và `NotificationsSheet`; lần đầu mở app chạy `PhoneOnboardingHost`. Không còn vùng nào của khung mới hiện body cũ. Test JVM: `PhoneShellWiringTest` (mỗi `PhoneArea` hiện đúng màn mới; drawer mở đúng sheet; onboarding chỉ hiện lần đầu).
  - _Requirements: 2.1, 2.2, 3.1, 4.1, 5.4, 5.6, 6.1, 8.1, 9.1, 12.1, 13.1, 14.1_
  - _Deps: 7, 9, 10, 11, 13, 14, 16, 17, 18, 19_
  - _Files: ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/PhoneShell.kt, ../ppm-android/app/src/main/kotlin/com/hienlh/ppm/app/ui/phone/PhoneAreaHosts.kt, ../ppm-android/app/src/test/kotlin/com/hienlh/ppm/app/ui/phone/PhoneShellWiringTest.kt_
  - _Test: none — test JVM của app chạy bằng Gradle trong ../ppm-android_
  - _Screen: Foundation_
