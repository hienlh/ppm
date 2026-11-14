// Long cards as managers really write them, for tests/e2e/assistant-waiting-cards-long-e2e.mjs.
// The ppm ones are copied from real cards (a plan to approve, a review draft, a four-question
// card). The Nxsys ones keep only the ticket and PR numbers; every word of their content is made
// up here and holds no customer or tax data.

export const PLAN = {
  kind: "needs_decision",
  title: "Duyệt kế hoạch \"lịch chạy vào session có sẵn\" (7 phase)",
  body: [
    "Đã lập kế hoạch, CHƯA code. Đối chiếu với main 0.25.2. File: plans/261114-1815-session-schedules/.",
    "",
    "Mục tiêu: lịch chạy gửi lượt vào chính một session có sẵn và không mất khi PPM restart.",
    "",
    "7 phase:",
    "1. Thêm kind \"session\", múi giờ, lịch chạy 1 lần, dồn các lần lỡ, chạy bù 1 lần.",
    "2. Gửi lượt: chờ session rảnh, không đổi chế độ quyền của session, có khối ⏰.",
    "3. Xoá session thì xoá lịch; theo id mới khi Codex đổi id; tối đa 20 lịch mỗi session.",
    "4. Tool cho AI tự đặt, xem, xoá lịch; ẩn cron sẵn có của Claude.",
    "5. Giao diện: dòng \"⏰ đã chạy\", chip dưới ô chat, cột Session trong Settings.",
    "6. REST và `ppm schedule add --session --tz --once`.",
    "7. Test, e2e, docs.",
    "",
    "Main hiện ghi đè chế độ quyền của session và bỏ luôn lần chạy khi session đang bận. Kế hoạch sửa cả hai.",
    "",
    "6 điểm theo đề xuất:",
    "D1 dùng chung bảng schedules.",
    "D2 chạy bù chỉ áp dụng cho lịch session mới.",
    "D3 chặn CronCreate/List/Delete, giữ /loop.",
    "D4 tool mới mặc định tắt, tour hỏi 1 lần.",
    "D5 gặp thẻ duyệt thì chờ anh và báo \"đang chờ duyệt\".",
    "D6 tool của Assistant chưa nhắm vào session.",
    "",
    "Rủi ro: chưa kiểm cách tắt CronCreate trên CLI hiện tại; restart đúng lúc đang gửi có thể chạy 2 lần (hiếm); lịch dày trên session bypass sẽ tốn lượt.",
    "",
    "OK = duyệt kế hoạch với cả 6 đề xuất, rồi giao code trên nhánh riêng (không merge, không restart). Muốn đổi điểm nào thì trả lời, ví dụ \"D2 cả cũ\".",
  ].join("\n"),
};

export const REVIEW_DRAFT = {
  kind: "needs_decision",
  title: "Đăng yêu cầu sửa lên PR #89 (thangho98)?",
  body: "Anh đã chọn \"Soạn comment cho #89 và #91\". Đây là bản cho #89: review dạng \"request changes\", bằng tiếng Anh, đăng bằng tài khoản hienlh. Nội dung nhận xét mình đã tự kiểm trên main 93aa6f13: dropIdleSubprocess (src/server/ws/chat.ts:622) gọi abortQuery mà không kiểm supersededByLiveEntry. Anh OK thì mình đăng nguyên văn.",
  draft: {
    to: "GitHub PR #89 (hienlh/ppm), review: request changes",
    text: "Thanks, the bug is real and the fix is right for the three release paths it covers. One more door has the same hole: `dropIdleSubprocess` in `src/server/ws/chat.ts` still calls `abortQuery` without checking `supersededByLiveEntry(sessionId)`. It runs when an oversized image is removed and the message is sent again, and on a Codex account switch, and Codex always migrates the session id on its first turn. So a tab that missed the migration notice can still cut the running turn by switching accounts. Could you add the same guard there, with a test? The other `abortQuery` callers (`set_model`, `set_effort`, `set_thinking`, `ws_cancel`) are deliberate and should stay as they are.",
  },
};

export const NXSYS_DECISION = {
  kind: "needs_decision",
  title: "NX-6294 · PR #11179 review đạt sau 2 vòng sửa — merge vào develop ngay hay chờ QA chạy lại bộ kiểm thử đầy đủ?",
  body: [
    "PR #11179 sửa lỗi ở màn hình xuất báo cáo: khi người dùng huỷ một kỳ đã chốt rồi chốt lại, file xuất ra bị lặp dòng. Bản sửa gom dòng theo mã kỳ trước khi ghi file.",
    "",
    "Vòng 1 review chỉ ra 2 chỗ: thiếu test cho kỳ bị huỷ hai lần, và một truy vấn chạy trong vòng lặp. Dev đã sửa cả hai, thêm 3 test tích hợp.",
    "",
    "Vòng 2: đọc lại toàn bộ diff (14 file, +412 −96). CI xanh. Mình chạy lại test tích hợp trên máy, qua hết.",
    "",
    "Còn lại: QA chưa chạy bộ kiểm thử hồi quy trên staging. Nếu merge ngay, bản sửa vào đợt deploy chiều mai; nếu chờ QA thì trễ 1 ngày.",
    "",
    "OK = merge vào develop ngay, báo QA kiểm trên staging sau. Trả lời \"chờ QA\" nếu anh muốn đợi.",
  ].join("\n"),
};

export const NXSYS_URGENT = {
  kind: "urgent",
  title: "NX-6294: job xuất báo cáo đêm trên staging lỗi 3 lần liên tiếp từ 21:40, hàng đợi đang dồn",
  body: [
    "Job xuất báo cáo đêm trên staging thất bại 3 lần liên tiếp (21:40, 21:55, 22:10), cùng lỗi hết thời gian chờ kết nối.",
    "",
    "Hàng đợi đang có 37 việc chờ. Production không bị ảnh hưởng.",
    "",
    "Mình đã kiểm: không có deploy mới từ trưa; dịch vụ phụ thuộc trả lời chậm (8–12 giây mỗi lần gọi).",
    "",
    "Đề xuất: tạm dừng job đêm trên staging tới sáng, để dev kiểm dịch vụ phụ thuộc. Trả lời nếu anh muốn làm khác.",
  ].join("\n"),
};

/** Four questions, as a manager asked them with AskUserQuestion (Claude's input shape). */
export const QUESTIONS = [
  {
    header: "Lưu code",
    question: "3 worktree có 74 commit chỉ nằm trên máy này, GitHub chưa có: ppm-future-graph-core (37 commit + 17 file chưa commit, extension AI/Future Scenario Graph), ppm-midday-core (24 commit, extension CLI/notify), ppm-nxsys-ext-core (13 commit, extension chạy headless + composer, nhiều phần trùng future-graph). Ổ hỏng hoặc lỡ xóa worktree là mất. Lưu thế nào?",
    multiSelect: false,
    options: [
      { label: "Push nhánh lưu trữ (Recommended)", description: "Đẩy 3 nhánh lên GitHub dưới tên backup/..., không mở PR, không merge. File chưa commit thì commit tạm 'wip' trước. Có bản sao ngoài máy." },
      { label: "Chỉ lưu trên máy", description: "Tạo file git bundle trong ~/ppm-backups. Không đụng GitHub, nhưng máy hỏng thì vẫn mất." },
      { label: "Để nguyên", description: "Không làm gì. Code vẫn chỉ có ở worktree trên máy này." },
    ],
  },
  {
    header: "PR #87",
    question: "PR #87 'Spec mode' (AI viết requirements → design → tasks, anh duyệt từng bước rồi AI làm và chạy test) đã review đạt: cổng duyệt đúng (AI sửa tài liệu sau khi duyệt thì bị khóa lại), không rò RAM. Điểm cần quyết: bộ công cụ spec có thể chạy lệnh shell (lấy từ design.md đã duyệt) và PR để MẶC ĐỊNH BẬT cho mọi chat. Merge thế nào?",
    multiSelect: false,
    options: [
      { label: "Merge, mặc định tắt (Recommended)", description: "Sửa mặc định thành tắt rồi merge. Ai cần thì bật trong Settings → Tools. An toàn hơn cho bản đầu của công cụ chạy shell." },
      { label: "Merge, mặc định bật", description: "Merge như PR hiện tại. Giống cách db tools và session tools đang bật sẵn. Vẫn phải qua cổng duyệt trước khi chạy lệnh." },
      { label: "Chưa merge", description: "Giữ PR mở, xem lại sau." },
    ],
  },
  {
    header: "PR mới",
    question: "thangho98 mở 14 PR mới (#88–#101) ngày 13/11, chưa ai review. Có 5 PR sửa lỗi (#88 model mặc định chip chat, #89 socket session migrate, #93 trang design, #94 lỗi ký tự CHANGELOG, #95 đổi tunnel không restart server) và 9 PR tính năng (pin tab, search kiểu VS Code, gutter, feed thông báo, draft commit message, #101 'dùng lượt reset giới hạn Claude'). Còn #84 hàng đợi tin nhắn (10/11). Làm sao?",
    multiSelect: false,
    options: [
      { label: "Review hết, fix trước (Recommended)", description: "Giao chat 'Review PR' review 5 PR sửa lỗi trước, rồi tính năng. Chỉ báo kết quả, không tự merge hay comment lên GitHub khi chưa có anh OK." },
      { label: "Chỉ 5 PR sửa lỗi", description: "Review 5 PR fix trước, tính năng để sau." },
      { label: "Review và tự merge cái đạt", description: "Như cách anh từng giao: đạt thì approve + merge, chưa đạt thì request-changes. Mỗi lần merge vẫn báo anh." },
      { label: "Để sau", description: "Chưa review đợt này." },
    ],
  },
  {
    header: "Thư mục chính",
    question: "Thư mục chính C:\\Users\\PC\\ppm đang đứng ở bản 26/10, chậm main 453 commit, với 56 file thay đổi. Gần như tất cả đã có trên main, chỉ 1 sửa lỗi nhỏ chưa có (lọc đường dẫn Windows trong command palette, kèm test). Chat nào mở ở đây sẽ sửa trên code cũ. Xử lý thế nào?",
    multiSelect: false,
    options: [
      { label: "Lưu fix rồi về main (Recommended)", description: "Đưa sửa lỗi sang nhánh nhỏ (fix/palette-windows-path), cất 56 file vào một nhánh lưu, rồi đưa thư mục về main mới nhất. Không mất gì." },
      { label: "Giữ nguyên", description: "Không đụng vào. Nhớ đừng làm việc mới ở thư mục này." },
      { label: "Bỏ thay đổi, về main", description: "Bỏ luôn 56 file (gồm cả fix) rồi về main." },
    ],
  },
];
