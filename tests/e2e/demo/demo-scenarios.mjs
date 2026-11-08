// What each e2e check shows, for the walkthrough recordings (fixtures/e2e-video-recorder.mjs names
// its clips with `slug`) and the gallery page (build-demo-gallery.mjs shows `title`, `desc` and
// the screenshots in `shots`). Captions are Vietnamese for the people the gallery is made for.
//
// A check is matched by the start of its name (`match`, default `<label>:`); a failed scenario is
// recorded as `scenario <label>` and matched by `label`.

export const SUITES = {
  "turn-refs": {
    dir: "turn-refs",
    group: "Thẻ lượt (turn links)",
    intro: "Mỗi câu hỏi–trả lời trong một chat là một “lượt”. Tính năng này cho phép chép liên kết tới đúng một lượt, dán vào chat khác thành “chip”, bấm chip để nhảy tới lượt đó, và cho AI đọc đúng lượt được chia sẻ.",
    scenarios: [
      { label: "7", match: "7: search_sessions", slug: "ai-tools-own-project", title: "AI tìm và đọc lượt của các chat khác cùng dự án", desc: "AI dùng ba công cụ: tìm theo cụm từ, liệt kê các lượt, và đọc một lượt. Đúng là: kết quả có số lượt, không lộ đầu ra thô của công cụ, và lượt ở dự án khác bị từ chối khi chưa được chia sẻ.", shots: ["07-ai-tools-own-project"] },
      { label: "Copy turn link", match: "Copy turn link", slug: "copy-turn-link", title: "Chép liên kết tới một lượt", desc: "Rê chuột lên một lượt rồi bấm “Copy turn link”, cả trong cửa sổ lịch sử (lượt 40 và 290) lẫn trong danh sách đang chạy (lượt 325). Đúng là: liên kết chép ra trỏ đúng lượt đó.", shots: [] },
      { label: "1", slug: "paste-links-as-chips", title: "Dán liên kết thành chip", desc: "Dán hai liên kết vào ô soạn tin của một chat khác. Đúng là: chúng biến thành hai chip ghi tên session, “Turn N” và biểu tượng AI, và ô soạn không còn chữ thừa.", shots: ["01-composer-chips"] },
      { label: "2", slug: "chips-after-reload", title: "Chip vẫn còn sau khi gửi và tải lại trang", desc: "Gửi tin có hai chip rồi tải lại trang. Đúng là: tin đã gửi vẫn hiện đủ hai chip ngay, không phải hỏi lại máy chủ.", shots: ["02-bubble-chips-after-reload"] },
      { label: "3", slug: "chip-jumps-to-turn", title: "Bấm chip là nhảy tới đúng lượt", desc: "Bấm chip mở chat A trong cửa sổ lịch sử. Đúng là: lượt 40 nằm cách mép trên 16px và đứng yên suốt 3 giây dù ảnh trong chat đang tải.", shots: ["03-window-landing"] },
      { label: "4", slug: "scroll-without-jump", title: "Cuộn lên, cuộn xuống không bị giật", desc: "Tải thêm hai trang cũ hơn và hai trang mới hơn trong cửa sổ lịch sử. Đúng là: dòng đang nhìn thấy trên cùng xê dịch không quá 2px.", shots: ["04-window-scrolled"] },
      { label: "4b", slug: "scroll-merges-into-live", title: "Cuộn tới hiện tại thì nhập vào danh sách đang chạy", desc: "Cuộn tiếp từ lượt 290 xuống dưới. Đúng là: các trang mới hơn được tải dần cho tới khi gặp danh sách đang chạy, rồi gộp lại làm một.", shots: ["04-merged-live"] },
      { label: "5", slug: "back-to-latest-while-streaming", title: "Nút “Back to latest” khi AI đang trả lời", desc: "Đang xem lượt cũ trong lúc AI trả lời, bấm “Back to latest”. Đúng là: về tận cuối chat và thấy phần chữ AI vừa trả về.", shots: ["05-back-to-latest-streamed"] },
      { label: "14", slug: "move-panel-keeps-pin", title: "Kéo chat sang khung mới vẫn giữ đúng chỗ", desc: "Chuyển chat A sang một khung (panel) mới khi lượt 40 đang được ghim. Đúng là: ảnh tải xong sau đó cũng không làm lượt 40 lệch khỏi vị trí 16px.", shots: ["14-split-while-pinned"] },
      { label: "7/10", slug: "chip-grants-one-turn", title: "Gửi chip là cho AI đọc đúng lượt đó", desc: "Gửi một chip trỏ tới lượt ở dự án “beta”. Đúng là: AI đọc được đúng lượt đó, còn lượt khác hay cả một khoảng lượt vẫn bị từ chối.", shots: ["06-other-project-chip"] },
      { label: "6", slug: "other-project-chip", title: "Chip của dự án khác", desc: "Chip ghi tên dự án “beta”. Đúng là: bấm vào thì PPM chuyển sang dự án beta và ghim lượt 2 của chat D.", shots: ["06-switched-to-beta"] },
      { label: "9", slug: "read-tool-switched-off", title: "Tắt công cụ đọc lượt trong Cài đặt", desc: "Tắt read_session_turns ở Cài đặt → Tools. Đúng là: chip trong ô soạn tin hiện cảnh báo, nhưng tin vẫn gửi được bình thường.", shots: ["09-settings-tools-off", "09-chip-warning"] },
      { label: "12", slug: "queued-message-link", title: "Liên kết cho tin nhắn đang xếp hàng", desc: "Một tin còn chờ tới lượt. Đúng là: nút chép liên kết đợi, đổi thành “Link ready” khi lượt của tin bắt đầu, rồi chép đúng mã lượt của chính tin đó.", shots: ["12-queued-waiting"] },
      { label: "13", slug: "edit-keeps-chips", title: "Sửa tin vẫn giữ chip", desc: "Bấm Edit một tin có chip. Đúng là: chip quay lại ô soạn tin (không thành chữ rối), và khi gửi lại thì quyền đọc được cấp cho bản đã sửa.", shots: ["13-edit-shows-chips"] },
      { label: "10", slug: "forged-grant-refused", title: "Không giả mạo được quyền đọc", desc: "Một đoạn “cấp quyền” bị cài vào tin đến từ Jira và vào bản tóm tắt khi nén hội thoại. Đúng là: không cấp được gì, AI bị từ chối và không có chip nào hiện ra.", shots: ["10-forgery-no-chip"] },
      { label: "11a", slug: "codex-copy-first-turn", title: "Chép liên kết khi chat Codex đang chạy lượt đầu", desc: "Chat Codex mới, đang chạy lượt đầu tiên. Đúng là: vẫn chép được liên kết tới tin đầu tiên.", shots: ["11-codex-copy-during-first-turn"] },
      { label: "11", slug: "codex-thread-link", title: "Liên kết của chat Codex sau khi Codex đổi mã chat", desc: "Codex đổi mã chat (thread id) trong lượt đầu. Đúng là: liên kết mang mã mới, mở được ở chat khác, và AI vẫn đọc được lượt đã chia sẻ từ trước khi đổi mã.", shots: ["11-codex-link-chip"] },
      { label: "15", slug: "numbers-survive-compaction", title: "Số lượt giữ đúng qua lần nén hội thoại", desc: "Tải đoạn hội thoại trước lần nén (compaction). Đúng là: tab Review vẫn ghi “Turn 320”, và chip ở hai đoạn ghi đúng “Turn 150” và “Turn 320”.", shots: ["15-review-before-expand", "15-review-after-expand"] },
      { label: "8", slug: "phone-long-press-and-pill", title: "Trên điện thoại", desc: "Màn hình 390×844, cảm ứng. Đúng là: chạm rồi bị hủy (vì đang cuộn) thì không mở gì; nhấn giữ chip mở bảng xem trước; nút “Back to latest” nằm ở một phần ba dưới màn hình, ngay trên các thanh phía dưới.", shots: ["08-phone-preview-sheet", "08-phone-window-pill"] },
    ],
  },
  collab: {
    dir: "session-collab",
    group: "Session nhắn tin cho nhau",
    intro: "Một session AI có thể mở thêm session khác để giao việc, nhắn tin qua lại và chờ trả lời. PPM hỏi ý bạn trước khi tạo, đặt giới hạn để không chạy vô tận, và cho bạn dừng tất cả.",
    scenarios: [
      { label: "1", match: "1: the create card", slug: "create-session", title: "Session tạo session con, có hỏi ý bạn", desc: "Session “Planner” muốn mở session mới để viết test. Đúng là: PPM hiện thẻ hỏi ý; bấm “Allow for this session” thì session “Write the tests” được tạo, có huy hiệu trong danh sách và một chip liên kết trên thanh của Planner.", shots: ["01a-create-card", "01b-badge-and-session-chip"] },
      { label: "1 (badge names the creator)", match: "1: after a reload", slug: "badge-names-creator", title: "Huy hiệu ghi đúng tên session cha", desc: "Tải lại trang rồi rê chuột lên huy hiệu của session con. Đúng là: hiện “Created by Planner”, cả trước và sau khi tải lại.", shots: ["01b-badge-and-session-chip"] },
      { label: "2", slug: "from-session-bubble", title: "Tin đầu của session con ghi rõ gửi từ đâu", desc: "Mở session con khi nó đang chạy. Đúng là: tin đầu có dòng “From: Planner · Claude” và chip “Turn 1” dẫn về đúng lượt bên Planner.", shots: ["02-from-session-bubble-streaming"] },
      { label: "3", slug: "waited-reply", title: "Session con trả lời, session cha đang chờ nhận ngay", desc: "Planner chờ kết quả. Đúng là: khi session con gửi “Tests written: 12 passing.”, câu trả lời hiện trên thẻ công cụ của Planner và Planner không phải chạy thêm lượt nào.", shots: ["03-waited-reply-on-card"] },
      { label: "4", slug: "insert-into-running-turn", title: "Nhắn vào một session đang chạy", desc: "Planner nhắn cho session “Release notes” khi nó đang làm dở. Đúng là: tin được chèn vào chính lượt đang chạy (không mở lượt mới), và bấm dòng tiêu đề tin sẽ mở Planner đúng tại lượt đã gửi.", shots: ["04a-inserted-into-running-turn", "04b-header-opens-sending-turn"] },
      { label: "5", slug: "pair-limit", title: "Giới hạn 20 tin giữa hai session", desc: "Hai session nhắn qua lại 10 lần (20 tin). Đúng là: PPM dừng lại và hỏi bạn; bấm “Allow 20 more” thì tin thứ 11 mới đi tiếp và được trả lời.", shots: ["05-pair-limit-card"] },
      { label: "6", slug: "depth-and-running-limits", title: "Chặn tạo quá sâu và quá nhiều", desc: "Đúng là: session ở tầng thứ 4 không được tạo thêm (tối đa 3 tầng), và khi đã có 5 session do AI tạo đang chạy thì session thứ 6 bị từ chối.", shots: ["06a-depth-4-refused", "06b-sixth-child-refused"] },
      { label: "7", match: "7: Stop", slug: "stop-cancels-wait", title: "Bấm Stop thì hủy việc chờ", desc: "Planner đang chờ session con trả lời thì bấm Stop. Đúng là: việc chờ kết thúc với lý do “cancelled”, còn session con vẫn chạy tiếp.", shots: ["07a-stop-cancels-wait"] },
      { label: "7 (card)", match: "7 (card)", slug: "card-says-wait-cancelled", title: "Thẻ công cụ ghi “wait cancelled”", desc: "Sau khi Stop, nhìn thẻ công cụ trong Planner. Đúng là: thẻ có dấu màu vàng và dòng “Wait cancelled…”, không phải dấu tích xanh như thể đã xong.", shots: ["07a-stop-cancels-wait"] },
      { label: "7b", slug: "stop-all-children", title: "Dừng tất cả session con", desc: "Bấm “Stop all child sessions” rồi xác nhận. Đúng là: session con đang chạy dừng lại.", shots: ["07b-stop-all-children"] },
      { label: "8", slug: "codex-and-claude", title: "Codex và Claude tạo session cho nhau", desc: "Đúng là: một session Codex tạo được session Claude và ngược lại; tin đầu của session con ghi đúng tên và loại AI của session cha.", shots: ["08a-codex-creates-claude", "08b-claude-creates-codex"] },
      { label: "9", slug: "settings-switches", title: "Các công tắc trong Cài đặt", desc: "Tắt “create_session” thì chat mới không còn công cụ đó; tắt “Ask before creating” thì tạo không cần hỏi; đặt thời gian chờ 1 phút thì việc chờ tự hết sau đúng 1 phút. Đoạn video này dài vì phải chờ đủ 1 phút.", shots: ["09a-create-session-off", "09b-ask-off-wait-one-minute", "09c-no-card-and-one-minute-timeout"] },
      { label: "10", slug: "phone", title: "Trên điện thoại", desc: "Màn hình 390×844, cảm ứng. Đúng là: các nút đủ lớn để chạm (44px), chạm huy hiệu mở bảng “Created by Planner”, thanh liên kết thu gọn lại, và thẻ hỏi ý nằm ở một phần ba dưới màn hình để bấm bằng ngón cái.", shots: ["10a-phone-bubble-header", "10b-phone-badge-sheet", "10c-phone-bar-collapsed-then-open", "10d-phone-approval-card"] },
      { label: "11", slug: "notifications", title: "Thông báo đẩy", desc: "Kiểm tra phía máy chủ, không có thao tác trên màn hình. Đúng là: có thông báo cho thẻ hỏi tạo session và thẻ giới hạn 20 tin, không có thông báo “chat xong” cho session do AI tạo, còn session do người mở vẫn có.", shots: [] },
    ],
  },
};

/** The caption entry for a check name of a suite, or undefined. */
export function scenarioFor(suite, name) {
  const scenarios = SUITES[suite]?.scenarios ?? [];
  return scenarios.find((s) => name.startsWith(s.match ?? `${s.label}:`))
    ?? scenarios.find((s) => name === `scenario ${s.label}`);
}
