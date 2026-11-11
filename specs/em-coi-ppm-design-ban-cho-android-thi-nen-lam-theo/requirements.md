# Requirements: Em coi PPM design bản cho android thì nên làm theo

## Introduction

Đưa bản thiết kế `designs/ppm-mobile-tablet-redesign` (design "PPM mobile & tablet redesign", 16 trang: Foundation, Phone 1–7, Tablet 1–7) vào app Android native (`~/Projects/ppm-android`, Kotlin + Compose). Người dùng là anh, dùng PPM từ điện thoại khi đi ra ngoài và từ tablet như một máy làm việc thứ hai. Phone chỉ giữ các tính năng cơ bản, sắp cho một ngón cái; tablet có đủ mọi thứ web có, dùng bằng tay hoặc bàn phím + chuột.

Phạm vi:
- Bản thiết kế là spec của giao diện; tính năng và logic vẫn giống web. Bản này thay cho nguyên tắc "giống hẳn web" cũ của app trên cả phone lẫn tablet.
- Gồm cả những thay đổi phía server mà app cần: trạng thái đã đọc/chưa đọc của từng thông báo, viết commit message bằng AI, gửi push.
- Không gồm: app iPhone/iPad (làm sau, từ cùng bản thiết kế); app Mac (`ppm-apple` vẫn port web 1:1); các thay đổi giao diện web (Staged/Changes, Write with AI trên web, hỏi lại khi xóa project) — những việc đó nằm ở `plans/261110-1400-web-git-from-mobile-design/plan.md`.

Chữ trên giao diện giữ tiếng Anh như bản thiết kế. "Phone" là màn hình hẹp hơn 600 dp, "tablet" là từ 600 dp trở lên.

UI: yes

## Requirements

### Requirement 1: Hai cỡ màn hình

**User Story:** As a PPM user, I want the app to pick the phone or the tablet layout from the window size, so that each device gets the layout drawn for it.

#### Acceptance Criteria

1. WHEN the app window is narrower than 600 dp THE SYSTEM SHALL show the phone layout described in the Foundation and Phone 1–7 pages.
2. WHEN the app window is 600 dp wide or wider THE SYSTEM SHALL show the tablet layout described in the Foundation and Tablet 1–7 pages.
3. WHEN the window crosses 600 dp (rotation, split screen, a foldable) THE SYSTEM SHALL switch layout while keeping the open project, the open tabs, the chat draft and the scroll position of the current screen.
4. WHEN a screen is drawn THE SYSTEM SHALL use the design's tokens (colours, type scale, radii, spacing, touch targets of at least 48 dp) for the active theme.

### Requirement 2: Điều hướng trên phone

**User Story:** As a phone user, I want one navigation model on every screen, so that I always know where the menu, the tabs and the main action are.

#### Acceptance Criteria

1. WHEN any phone screen is shown THE SYSTEM SHALL show an app bar with ☰ on the left, the current tab's title in the middle and at most two actions on the right, and no bottom tab bar.
2. WHEN the user taps ☰ THE SYSTEM SHALL open the drawer with the project switcher, the screens the phone has, the Cloud & Share tile, Notifications and Settings.
3. WHEN the user taps the title THE SYSTEM SHALL open the tab switcher listing the project's open tabs, with close and new-tab actions.
4. WHEN a screen has a main action (Send, Commit, Save, Run now, Connect) THE SYSTEM SHALL place it in the bottom card above the system navigation and above the keyboard while it is open.
5. WHEN the user presses the system Back THE SYSTEM SHALL close the topmost sheet, then the drawer, then return to the previous tab, and only then leave the app.

### Requirement 3: Những gì phone có và không có

**User Story:** As a phone user, I want only the features that work on a small screen, so that nothing on the phone is too cramped to use.

#### Acceptance Criteria

1. WHEN the phone layout is shown THE SYSTEM SHALL offer exactly the areas in the design's "What a phone has" table: Chat (all of it), Projects, Files basic, Source Control basic, one Terminal, Database read-only, Monitor, Logs, Schedules, Port forwarding, Cloud & Share, and the reduced Settings.
2. WHEN a tablet-only feature is reached on a phone (a deep link, a notification, a tab opened on another device) THE SYSTEM SHALL show one line saying it opens on a tablet, instead of a broken or partial screen.
3. WHEN a tab opened on a tablet is of a type the phone does not show THE SYSTEM SHALL keep that tab in the project's layout unchanged so the tablet and the web still find it.

### Requirement 4: Chat

**User Story:** As a PPM user, I want the full chat on both phone and tablet, so that I can follow and drive the AI from any device.

#### Acceptance Criteria

1. WHEN a chat is open on either layout THE SYSTEM SHALL offer everything the web's chat offers: messages, tool and agent cards, approvals and questions, the composer with attachments, the `/` and `@` pickers, the model/effort/permission chips, the queue, history and the footer, laid out as Phone 1 and Tablet 1.
2. WHEN a card waits for the user (an approval, a question, a PPM password prompt) and it is out of view THE SYSTEM SHALL show a "Needs you" pill that scrolls to it.
3. WHEN chat history is listed THE SYSTEM SHALL group sessions by day and let a swipe on a row reveal its row actions.
4. WHEN a chat is open on a tablet THE SYSTEM SHALL keep the message navigator visible beside the transcript.
5. WHEN a chat is open on a tablet THE SYSTEM SHALL allow it to sit in a split pane beside an editor or a terminal, with agents docked as the design shows.

### Requirement 5: Server, project và lần đầu mở app

**User Story:** As a PPM user, I want to connect to my servers and manage projects from the app, so that I do not need the web for setup.

#### Acceptance Criteria

1. WHEN the user connects to a server THE SYSTEM SHALL follow Phone 2's connect flow (address, password, saved servers) and remember the server.
2. IF the address is plain HTTP and is not loopback, a private LAN address or a Tailscale address (100.64.0.0/10) THEN THE SYSTEM SHALL warn that the password would cross the internet unencrypted before sending it, and send it only after the user confirms.
3. WHEN the device itself has no network THE SYSTEM SHALL show "This phone is offline" instead of reporting the server as unreachable.
4. WHEN the user opens the project switcher THE SYSTEM SHALL let them switch, add, clone, rename, recolour and remove projects on both layouts.
5. WHEN the user asks to remove a project THE SYSTEM SHALL ask for confirmation first and remove it only after the user confirms.
6. WHEN the app is opened for the first time on a device THE SYSTEM SHALL show the onboarding drawn in Phone 2 / Tablet 2.

### Requirement 6: Danh sách thông báo

**User Story:** As a PPM user, I want to mark single notifications read or unread and see schedule runs among them, so that the list works as an inbox rather than something I can only clear.

#### Acceptance Criteria

1. WHEN the notification list is shown THE SYSTEM SHALL show each notification's read state and let the user mark one read or unread.
2. WHEN a notification is marked read or unread on one device THE SYSTEM SHALL show the same state on every other device of that server, the web included.
3. WHEN a schedule run produces a notification THE SYSTEM SHALL list it in the same list.
4. WHEN the server is older and has no per-notification read state THE SYSTEM SHALL fall back to the existing Clear all behaviour without errors.

### Requirement 7: Push notification

**User Story:** As a PPM user, I want native notifications when the AI finishes, asks something or needs approval, so that I can leave the app and come back only when needed.

#### Acceptance Criteria

1. WHEN PPM sends a notification the user has switched on THE SYSTEM SHALL show it as a native Android notification in the channel of its kind (approval or question, chat finished, schedule, other).
2. WHEN the user taps a notification THE SYSTEM SHALL open the app on the session or screen it is about.
3. WHEN notifications are not yet allowed THE SYSTEM SHALL ask for the Android permission only when the user turns the switch on in Settings → Notifications, never at first launch.
4. WHEN the app is not running THE SYSTEM SHALL still receive and show the notification, through a delivery path that works with a self-hosted PPM (chosen in design.md).

### Requirement 8: Files

**User Story:** As a PPM user, I want to read and lightly edit project files on the phone and work with them fully on a tablet, so that each device does what fits it.

#### Acceptance Criteria

1. WHEN Files is open on a phone THE SYSTEM SHALL let the user browse the tree, view code, images, Markdown and PDF, and make a small edit and Save, as Phone 3 shows.
2. WHEN a PDF is opened on either layout THE SYSTEM SHALL show it page by page.
3. WHEN Files is open on a tablet THE SYSTEM SHALL offer the full explorer, the editor with LSP and inline blame, diff and compare, every viewer, project search and replace, multi-select and drag to move, and the OS File Explorer, as Tablet 3 shows.
4. WHEN the user runs Replace All THE SYSTEM SHALL say how many matches in how many files will change and replace only after the user confirms.
5. WHEN the OS File Explorer is opened on a tablet THE SYSTEM SHALL open it as a tab, not as a floating window.

### Requirement 9: Source Control trên phone

**User Story:** As a phone user, I want to review, stage, commit and push changes, so that I can finish a small change away from my desk.

#### Acceptance Criteria

1. WHEN Source Control is open on a phone THE SYSTEM SHALL list changed files in two groups, Staged and Changes, and show a partly staged file in both.
2. WHEN the user taps a file THE SYSTEM SHALL show that file's diff.
3. WHEN the user stages or unstages a file THE SYSTEM SHALL move the whole file between the groups.
4. WHEN the user chooses "Discard changes…" from a file's long-press sheet THE SYSTEM SHALL ask for confirmation, discard that whole file, and offer Undo for 8 seconds, as Phone 4 · SC8 shows.
5. WHEN the user commits, pushes, pulls or switches branch THE SYSTEM SHALL run the same operation as the web and show its result or error in place.
6. WHEN the phone layout is shown THE SYSTEM SHALL not offer block or line staging, block or line discard, Discard all, Review changes, Git Graph, stash, worktrees, conflict resolution or blame.

### Requirement 10: Write with AI

**User Story:** As a PPM user, I want the AI to draft the commit message from what is staged, so that committing from a phone does not need much typing.

#### Acceptance Criteria

1. WHEN the user taps Write with AI with something staged THE SYSTEM SHALL generate a commit message from the staged diff and put it in the message box.
2. WHILE the message is being written THE SYSTEM SHALL show the writing state and keep the Commit button disabled.
3. WHEN a message has been written THE SYSTEM SHALL leave it editable and never commit by itself.
4. IF nothing is staged THEN THE SYSTEM SHALL disable Write with AI and say why.
5. IF generation fails THEN THE SYSTEM SHALL keep whatever the user had typed and show the failure with a retry.
6. WHEN Write with AI is called THE SYSTEM SHALL use one server endpoint that the web can later use as well.

### Requirement 11: Source Control và Git Graph trên tablet

**User Story:** As a tablet user, I want the web's full Source Control, so that the tablet is a real place to review and commit.

#### Acceptance Criteria

1. WHEN Source Control is open on a tablet THE SYSTEM SHALL offer everything Tablet 4 shows: Staged/Changes, block and line staging and discard, Discard all, Review changes, branches, stash, worktrees, conflicts, blame and the Git Graph.
2. WHEN a project folder holds several repositories THE SYSTEM SHALL let the user pick the repository, as the web does.

### Requirement 12: Terminal

**User Story:** As a PPM user, I want a terminal on the phone and a full terminal setup on a tablet, so that I can run a command from anywhere.

#### Acceptance Criteria

1. WHEN Terminal is open on a phone THE SYSTEM SHALL show one terminal with the key row (Esc, Tab, Ctrl, arrows and the design's other keys) above the keyboard.
2. WHEN the user opens the AI's command card in a chat THE SYSTEM SHALL open the Terminal screen on the AI's new terminal with the command typed and not run, while the user's own terminal keeps running on the server.
3. WHEN Terminal is used on a tablet THE SYSTEM SHALL offer several terminals, the dock and splits, as Tablet 4 shows.

### Requirement 13: Database

**User Story:** As a PPM user, I want to look at data from the phone and work with databases fully on a tablet, so that a phone cannot change data by accident.

#### Acceptance Criteria

1. WHEN Database is open on a phone THE SYSTEM SHALL let the user browse connections and tables, view rows and read saved queries, with no control that writes.
2. WHEN Database is open on a tablet THE SYSTEM SHALL offer connections and their forms, the data grid with editing and saving, the Query tab, write access, structure and import/export, as Tablet 5 shows.

### Requirement 14: Công cụ

**User Story:** As a PPM user, I want the tools that fit each device, so that I can check the machine and the schedules from the phone and do everything from a tablet.

#### Acceptance Criteria

1. WHEN the phone layout is shown THE SYSTEM SHALL offer Monitor and Logs to read, Port forwarding, and Cloud & Share as a tile in the drawer, as Phone 7 shows.
2. WHEN Schedules is open on a phone THE SYSTEM SHALL show it as a Settings page where each schedule can be turned on or off, run now and its log read, with the main action in the bottom card, and with no script editing.
3. WHEN the tablet layout is shown THE SYSTEM SHALL also offer Remote Desktop, the Android device, Extensions, Designs, Schedules with editing, Teams and Jira, as Tablet 7 shows.
4. WHEN Remote Desktop or Logs is opened on a tablet THE SYSTEM SHALL open it as a tab, not as a floating window.

### Requirement 15: Settings

**User Story:** As a PPM user, I want the settings I need on a phone and all of them on a tablet, so that the phone's Settings stays short.

#### Acceptance Criteria

1. WHEN Settings is open on a phone THE SYSTEM SHALL show Accounts, AI model / effort / permission, Notifications, Theme, Servers and About as full pages.
2. WHEN Settings is open on a phone THE SYSTEM SHALL show every other section as one line reading "Open on a tablet".
3. WHEN Settings is open on a tablet THE SYSTEM SHALL show every section the web has, as a list beside the selected section's detail.

### Requirement 16: Tablet với bàn phím và chuột

**User Story:** As a tablet user with a keyboard and mouse attached, I want the app to behave like a desktop app, so that the tablet replaces a laptop for daily work.

#### Acceptance Criteria

1. WHEN a mouse or trackpad hovers a control THE SYSTEM SHALL show the hover state and tooltip the design gives it.
2. WHEN the user right-clicks an item that has a long-press menu THE SYSTEM SHALL open the same menu at the pointer.
3. WHEN a hardware keyboard is attached THE SYSTEM SHALL support the web's shortcuts and the keyboard rules in the Foundation page (focus ring, Tab order, Escape closes the top layer).
4. WHEN only touch is used on a tablet THE SYSTEM SHALL keep every action reachable without hover, right-click or a keyboard.

### Requirement 17: Đúng với bản thiết kế

**User Story:** As the owner of the design, I want each built screen checked against its drawing, so that the app does not drift from the design.

#### Acceptance Criteria

1. WHEN a screen is built THE SYSTEM SHALL match its frame in the design (layout, sizes, colours and states) on the reference phone (412 × 915 dp) and the reference tablet (1280 × 800 dp), checked by screenshots taken at the same size.
2. WHEN a screen's behaviour or data differs from the web's THE SYSTEM SHALL follow the web's logic unless the design's decisions table says otherwise.
