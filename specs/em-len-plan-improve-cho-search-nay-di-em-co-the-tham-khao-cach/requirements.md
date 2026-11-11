# Requirements: em lên plan improve chỗ search này đi em... có thể tham khảo cách làm của vs…

## Introduction

Nâng cấp panel Search ở sidebar (`src/web/components/explorer/search-panel.tsx`, backend `src/services/project-content-search.service.ts` qua `GET /files/search`) cho gần với Search view của VS Code. Người dùng là anh, tìm và thay chữ trong cả project, trên desktop lẫn điện thoại (mobile drawer).

Những chỗ đang thiếu hoặc sai, đo từ code hiện tại:
- Mỗi file chỉ trả tối đa 5 kết quả (`--max-count=5`) mà không báo gì; số "N results" vì thế sai.
- Tìm cả file bị `.gitignore` (`rg -uu`); chỉ loại được một danh sách thư mục cứng. Không có ô "Files to exclude".
- "Files to include" lọc sau khi tìm xong, nên vẫn phải quét cả project và vẫn dính giới hạn 8 MB / 10 s.
- Quá nhiều kết quả thì báo lỗi, không hiện được phần nào.
- Whole Word và Regex không bật cùng lúc được. Regex được kiểm bằng JS ở trình duyệt nhưng chạy bằng ripgrep/grep ở server, hai engine khác nhau.
- Replace All không hỏi lại, đọc rồi ghi từng file bằng regex JS (có thể thay khác với cái đã hiện), lỗi bị nuốt, không thay từng file / từng kết quả được, không có preview, không có Preserve Case.
- Mở kết quả chỉ nhảy tới đầu dòng, không chọn đúng chữ khớp. Dòng dài bị cắt bên phải nên chữ khớp có thể không thấy.
- Tooltip ghi Alt+C/W/R nhưng phím tắt không có. Không đi qua kết quả bằng bàn phím, không có lịch sử tìm.
- Đổi sang panel khác rồi quay lại là mất hết từ khóa và kết quả.
- ripgrep/grep đã chạy ở process riêng, nhưng việc spawn, đọc tới 8 MB output, parse, sort và dựng JSON trả về đều chạy trên main thread của server. Bỏ giới hạn 5 kết quả/file và thêm cột khớp sẽ làm phần này nặng hơn. Replace thì đang chạy ở trình duyệt, mỗi file hai request. Bản mới không để search/replace chạy gì trên main thread ngoài việc nhận request và trả response.

Phạm vi không gồm: Search Editor (mở kết quả thành tab), tìm trong nội dung chưa lưu của editor, tìm nhiều dòng, thay đổi Quick Open / command palette.

Chữ trên giao diện giữ tiếng Anh, theo cách VS Code gọi.

UI: yes

## Requirements

### Requirement 1: Kết quả đầy đủ và đúng số

**User Story:** As a PPM user, I want every match in the project listed with a correct count, so that I can trust the result before acting on it.

#### Acceptance Criteria

1. WHEN a search runs THE SYSTEM SHALL return every matching line of every file, with no per-file cap.
2. WHEN a line holds more than one match THE SYSTEM SHALL report each match with its column range, and count each one in the total.
3. WHEN the matches exceed the result limit (20,000 matches, as VS Code) THE SYSTEM SHALL show the matches found up to the limit and a notice that the results were cut short, instead of an error.
4. WHEN a search hits the time limit THE SYSTEM SHALL show the matches found so far and a notice that the search did not finish.
5. WHEN a new query is typed while a search is running THE SYSTEM SHALL stop the running search on the server.
6. WHEN results are shown THE SYSTEM SHALL show "N results in M files" counting every match listed.

### Requirement 2: Chọn file để tìm (include, exclude, ignore files)

**User Story:** As a PPM user, I want to say which files to search and which to skip, so that generated and ignored files stay out of my results.

#### Acceptance Criteria

1. WHEN "Use Exclude Settings and Ignore Files" is on (the default) THE SYSTEM SHALL skip files ignored by the project's `.gitignore`, `.ignore` and `.rgignore`, and the default excluded folders.
2. WHEN "Use Exclude Settings and Ignore Files" is off THE SYSTEM SHALL search ignored files and the default excluded folders too.
3. WHEN "Files to exclude" holds comma-separated globs THE SYSTEM SHALL leave out every file matching one of them.
4. WHEN "Files to include" holds comma-separated globs THE SYSTEM SHALL search only files matching one of them, applying the filter while searching rather than after.
5. WHEN a glob has no `/` THE SYSTEM SHALL match it at any depth, and WHEN it ends in `/**` or names a folder THE SYSTEM SHALL match everything under that folder, as VS Code does.
6. WHEN the include and exclude fields are collapsed THE SYSTEM SHALL keep applying their values and show that filters are active on the toggle.

### Requirement 3: Tùy chọn khớp chữ

**User Story:** As a PPM user, I want Match Case, Whole Word and Regex to combine freely and behave the same everywhere, so that what I search is what I replace.

#### Acceptance Criteria

1. WHEN Match Whole Word and Use Regular Expression are both on THE SYSTEM SHALL search the regex bounded by word boundaries.
2. WHEN a regex is invalid for the engine that runs the search THE SYSTEM SHALL mark the field and show the engine's reason, and search nothing.
3. WHEN a regex uses look-around or back-references THE SYSTEM SHALL still search it (as VS Code falls back to PCRE2), or report clearly that this host cannot.
4. WHEN results are highlighted in the list THE SYSTEM SHALL highlight exactly the column ranges the server reported, not a range recomputed in the browser.
5. WHEN focus is in the search panel and Alt+C, Alt+W or Alt+R is pressed THE SYSTEM SHALL toggle Match Case, Match Whole Word or Use Regular Expression.

### Requirement 4: Hiển thị và mở kết quả

**User Story:** As a PPM user, I want each result to show the match itself and open right on it, so that I can read and jump without hunting.

#### Acceptance Criteria

1. WHEN a matching line is longer than the row THE SYSTEM SHALL show a slice of the line around the match so that the match is visible, with an ellipsis where text was cut.
2. WHEN a result is opened THE SYSTEM SHALL open the file with the matched text selected and scrolled into view.
3. WHEN a result row is hovered or focused THE SYSTEM SHALL offer Dismiss (and Replace when a replace text is set), and WHEN a file row is hovered THE SYSTEM SHALL also offer Copy Path.
4. WHEN Dismiss is used THE SYSTEM SHALL remove that match or file from the list and from the counts, and leave it out of Replace All.
5. WHEN the toolbar's Collapse All / Expand All or Clear Search Results is used THE SYSTEM SHALL collapse or expand every file, or empty the query and the list.
6. WHEN "View as Tree" is chosen THE SYSTEM SHALL group results under their folders, and WHEN "View as List" is chosen THE SYSTEM SHALL list files flat with their folder path, remembering the choice.

### Requirement 5: Thay thế an toàn

**User Story:** As a PPM user, I want to preview and replace matches one at a time, per file or all at once, so that a project-wide replace never surprises me.

#### Acceptance Criteria

1. WHEN a replace text is set THE SYSTEM SHALL show each match in the list as the old text struck through next to the new text.
2. WHEN a regex search has capture groups THE SYSTEM SHALL expand `$1`…`$n`, `$&` and `$0` in the replace text, in the preview and in the change, the same way.
3. WHEN Preserve Case is on THE SYSTEM SHALL keep the case shape of each match (all upper, all lower, capitalised) in its replacement.
4. WHEN Replace is used on one match or one file THE SYSTEM SHALL change only that match or the matches of that file, and remove them from the list.
5. WHEN Replace All is used THE SYSTEM SHALL ask for confirmation stating the number of matches and files, and after it SHALL change exactly the matches listed, excluding dismissed ones.
6. WHEN a file changed on disk after the search, so a listed match is no longer where it was THE SYSTEM SHALL skip that file and report it, rather than replace something else.
7. WHEN a replace fails for any file THE SYSTEM SHALL report which files failed and why, and report how many matches were replaced in the others.
8. WHEN a replaced file is open in an editor tab THE SYSTEM SHALL show the new content in that tab, and WHEN that tab has unsaved changes THE SYSTEM SHALL skip the file and report it.

### Requirement 6: Bàn phím, lịch sử và trạng thái

**User Story:** As a PPM user, I want to drive search from the keyboard and find it as I left it, so that searching is fast and nothing is lost when I switch panels.

#### Acceptance Criteria

1. WHEN focus is in the search field and Down is pressed with results shown THE SYSTEM SHALL move focus into the results, and WHEN Up/Down/Left/Right/Enter are pressed there THE SYSTEM SHALL move between rows, collapse/expand files and open the focused match.
2. WHEN F4 or Shift+F4 is pressed while results exist THE SYSTEM SHALL open the next or previous match, wrapping at the ends.
3. WHEN the search field is focused and Alt+Up/Alt+Down (or Up/Down when the field is empty) is pressed THE SYSTEM SHALL step through the last 20 queries of this project.
4. WHEN the search shortcut is pressed while an editor has text selected on one line THE SYSTEM SHALL open the panel with that text as the query.
5. WHEN the user switches to another sidebar panel or closes the mobile drawer and comes back THE SYSTEM SHALL show the same query, options, filters, replace text and results.
6. WHEN the active project changes THE SYSTEM SHALL show that project's own last search state.
7. WHEN the panel is shown on a phone THE SYSTEM SHALL give every option button and row action a touch target of at least 44 px and show row actions without hover.


### Requirement 7: Không đụng main thread

**User Story:** As a PPM user, I want search and replace to run entirely off the server's main thread, so that chats, terminals and the health check never wait on them, however big the project or the result.

#### Acceptance Criteria

1. WHEN a content search runs THE SYSTEM SHALL start the search tool (ripgrep or grep), read its output, parse, limit, sort and serialise the results outside the server's main thread, so that the main thread only hands the request over and sends back the finished response bytes.
2. WHEN a replace runs THE SYSTEM SHALL read, check, rewrite and write every file outside the server's main thread, so that the main thread only hands the request over and sends back the report.
3. WHEN a search or replace of any size runs THE SYSTEM SHALL keep every main-thread task it causes under 5 ms, with the main thread's time not growing with the number of matches or files.
4. WHEN the search tool is started on Windows THE SYSTEM SHALL keep it from inheriting the server's sockets, as the spawn guard in `windows-socket-inheritance.ts` does for main-thread spawns today.
5. WHEN the off-main-thread searcher cannot be started THE SYSTEM SHALL answer the search with a clear error and a Retry, log one warning, and never fall back to running the search on the main thread.
6. WHEN the searcher crashes, or a search outlives its time limit THE SYSTEM SHALL stop it and its search tool, answer that search with an error (keeping the matches found so far, as 1.4 says), and start a fresh searcher for the next search.
7. WHEN PPM is built for release THE SYSTEM SHALL include the searcher's code in the binary, named alike in the `build` script, `scripts/release.sh` and the release workflow.
8. WHEN the panel lists more results than fit on screen THE SYSTEM SHALL render only the rows in view, so that 20,000 results do not stall the browser.
