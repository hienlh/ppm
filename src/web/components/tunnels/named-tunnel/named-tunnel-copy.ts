/**
 * All user-facing strings for the named-tunnel setup flow, kept in one file so
 * a future i18n pass has a single place to swap. Vietnamese is the primary
 * language here — no English fallback is implemented yet.
 */
export const namedTunnelCopy = {
  askDomain: {
    title: "Bạn đã có domain trên Cloudflare chưa?",
    body: "Có domain riêng thì PPM có thể gắn một địa chỉ cố định (không đổi khi khởi động lại). Không có domain thì vẫn dùng bình thường với link tạm thời.",
    yes: "Có",
    no: "Chưa",
  },
  noDomain: {
    title: "Không sao cả",
    body: "PPM sẽ tiếp tục dùng link tạm thời (quick tunnel). Bạn có thể bật lại tính năng này bất cứ lúc nào trong mục Tunnel Manager.",
    close: "Đóng",
  },
  login: {
    title: "Đăng nhập Cloudflare",
    hint: "Mở link bên dưới để đăng nhập — có thể làm trên điện thoại nếu tiện hơn.",
    finishOnPhone: "Có thể hoàn tất bước này trên điện thoại nếu dễ hơn.",
    copy: "Sao chép",
    copied: "Đã sao chép",
    open: "Mở link",
    waiting: "Đang chờ đăng nhập…",
    slowTitle: "Vẫn đang đăng nhập?",
    slowBody: "Cloudflare đôi khi mất vài phút. Tiến trình vẫn đang chạy — bạn có thể tiếp tục chờ hoặc huỷ.",
    keepWaiting: "Tiếp tục chờ",
    cancel: "Huỷ",
  },
  timeout: {
    title: "Link đăng nhập đã hết hạn",
    body: "Link cũ hết hạn sau 5 phút không dùng. Bấm Thử lại để lấy link mới.",
    retry: "Thử lại",
  },
  cancelled: {
    title: "Đã huỷ đăng nhập",
    body: "Bạn đã huỷ quá trình đăng nhập Cloudflare.",
    retry: "Thử lại",
  },
  confirmZone: {
    title: "Xác nhận vùng miền",
    body: (zone: string) => `Máy này sẽ được gán một địa chỉ cố định dưới ${zone}. Tiếp tục?`,
    confirm: "Tiếp tục",
    startOver: "Bắt đầu lại",
  },
  needsRelogin: {
    title: "Cần đăng nhập lại Cloudflare",
    certInvalid: "Phiên đăng nhập Cloudflare đã hết hiệu lực.",
    certMismatch: "Chứng chỉ này thuộc một tài khoản Cloudflare khác — cần đăng nhập lại.",
    action: "Đăng nhập lại",
  },
  hostname: {
    title: "Chọn địa chỉ",
    prefixLabel: "Tiền tố",
    suffixHint: "Phần đuôi được cố định theo tài khoản bạn vừa đăng nhập.",
    submit: "Xác nhận",
  },
  applying: {
    title: "Đang thiết lập…",
  },
  done: {
    title: "Đã thiết lập xong",
    body: (hostname: string) => `Địa chỉ cố định: https://${hostname}`,
    close: "Đóng",
  },
  pending: {
    title: "Đã lưu — đang chờ áp dụng",
    restartHint: "Chạy lệnh `ppm restart` để áp dụng ngay.",
    close: "Đóng",
  },
  error: {
    title: "Có lỗi xảy ra",
    retry: "Thử lại",
    close: "Đóng",
  },
  section: {
    title: "Named Tunnel",
    modeQuick: "quick",
    modeNamed: "named",
    hostnameLabel: "Địa chỉ",
    tokenLabel: "Token",
    setup: "Thiết lập named tunnel",
    retry: "Thử lại",
    relogin: "Đăng nhập lại",
    disable: "Chuyển về quick tunnel",
    disableConfirm: "Bấm lần nữa để xác nhận",
    certInvalid: "Cần đăng nhập lại Cloudflare",
    certMismatch: "Chứng chỉ thuộc tài khoản Cloudflare khác — cần đăng nhập lại",
    authDisabled: "Bật xác thực PPM để dùng tên miền riêng",
    /** Small note next to the live-mode badge when the configured mode hasn't landed yet. */
    configuredAs: (mode: "quick" | "named") => `đã cấu hình: ${mode}`,
  },
} as const;
