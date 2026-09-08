# Research: Stream + điều khiển 1 cửa sổ trên máy host ngay trong PPM

**Ngày:** 2026-09-05 11:18 (Asia/Saigon) · **Câu hỏi:** "tôi có thể stream và điều khiển 1 window trên máy host trực tiếp trong ppm được không?"

## Kết luận nhanh (TL;DR)

**Được — nhưng có 2 điểm cần chấp nhận trước khi làm:**

1. **Stream 1 cửa sổ riêng lẻ: làm được** trên Windows (Windows Graphics Capture theo HWND, hoặc `ffmpeg gdigrab title=…` làm bản MVP). PPM đã sẵn hạ tầng ffmpeg + dò NVENC (`src/services/media-transcode/ffmpeg-capabilities.ts`), WebSocket, floating window, PiP → phần "hiện video trong 1 floating window" gần như đã có sẵn khung.
2. **Điều khiển "chỉ riêng cửa sổ đó" mà không đụng tới desktop thật: KHÔNG làm được một cách đáng tin cậy.** Windows không có API chính thức để gửi chuột/phím vào cửa sổ đang ở nền (background). `PostMessage` giả lập phím là hack không ổn định (Raymond Chen, 3/2025). Cách chắc ăn duy nhất là `SetForegroundWindow` + `SendInput` → cửa sổ đó sẽ nhảy lên trước mặt trên màn hình thật của host, chuột thật di chuyển. Người đang ngồi tại máy sẽ thấy và bị "giành" chuột.

→ Nếu mục tiêu là "remote vào máy mình từ điện thoại qua PPM để bấm vài nút trong 1 app" — hoàn toàn khả thi, chấp nhận việc app đó lên foreground. Nếu mục tiêu là "điều khiển app A trong khi tôi vẫn dùng app B tại bàn" — không có đường tử tế; cần tách session (RDP/virtual desktop), phạm vi khác hẳn.

**Transport:** vì PPM đi qua Cloudflare quick tunnel (chỉ HTTP/WS, không UDP) nên **WebRTC media không chạy được qua tunnel** (cần TURN riêng). Đề xuất **WebSocket + WebCodecs** (H.264 Annex-B từ ffmpeg → `VideoDecoder` trong trình duyệt → canvas). Đây là đúng đường PPM đã đi với terminal/chat.

---

## Bảng từ điển

| Từ | Nghĩa |
|---|---|
| HWND | "handle" — số định danh 1 cửa sổ trong Windows |
| WGC (Windows Graphics Capture) | API chụp màn hình/cửa sổ hiện đại của Windows 10 1903+, chạy trên GPU, OBS dùng cái này cho Window Capture |
| gdigrab / ddagrab | 2 "thiết bị đầu vào" của ffmpeg trên Windows: gdigrab chụp qua GDI (CPU, chậm, nhưng chụp được theo tên cửa sổ); ddagrab dùng Desktop Duplication (GPU, nhanh, nhưng chỉ chụp cả màn hình) |
| NVENC | bộ mã hoá video H.264/HEVC trên card NVIDIA, không tốn CPU |
| WebCodecs | API trình duyệt cho phép giải mã H.264 trực tiếp bằng JS/GPU (Chrome, Edge, Safari 16.4+) |
| WebRTC | giao thức truyền video thời gian thực P2P, cần UDP; là cái Google Meet dùng |
| SendInput / PostMessage | 2 cách giả lập chuột/phím trên Windows: SendInput = "bơm vào dòng input thật" (đúng chuẩn, nhưng chỉ tới cửa sổ foreground); PostMessage = "ném thẳng tin nhắn vào cửa sổ" (không đúng chuẩn, nhiều app bỏ qua) |
| Foreground | cửa sổ đang được focus, nằm trên cùng |

---

## 1. Chụp (capture) 1 cửa sổ trên host

| Cách | Chụp theo cửa sổ? | Cửa sổ bị che/phía sau? | Tốc độ | Ghi chú |
|---|---|---|---|---|
| **WGC** (`Windows.Graphics.Capture`) | ✅ theo HWND | ✅ vẫn chụp được nội dung dù bị che (không chụp được khi minimize) | GPU, 60fps thoải mái | Cần native helper (C#/Rust/C++). ffmpeg **không** có device WGC. Win10 1903+. |
| **ffmpeg gdigrab `-i title=X`** | ✅ theo tiêu đề | ❌ phần bị che sẽ lộ nội dung của cửa sổ đè lên | CPU, ~15–30fps ở 1080p | 0 dòng code native, PPM đã có `Bun.which("ffmpeg")` + chọn encoder. Hợp làm MVP. |
| **ffmpeg ddagrab** | ❌ cả màn hình (crop được theo toạ độ) | ✅ | GPU, 4K60 với NVENC | Nếu chấp nhận "stream vùng màn hình" thay vì "cửa sổ" thì đây là nhanh nhất. |
| Sunshine (đã có trên máy, port 48800) + moonlight-web | ❌ cả display / virtual display | ✅ | rất thấp latency | Sẵn có, nhưng là "cả desktop", cần pairing riêng, là hệ khác PPM. |

**Điểm mù chung mọi cách:** màn hình khoá (secure desktop), UAC prompt → khung đen, không điều khiển được. PPM phải chạy trong **phiên đăng nhập tương tác** của user (autostart qua Task Scheduler "at logon" thì ổn; chạy kiểu service session 0 thì chụp không được gì).

Cross-platform (để sau): macOS → ScreenCaptureKit lọc theo window (cần quyền Screen Recording); Linux X11 → `x11grab -window_id`; Wayland → PipeWire portal (bắt user bấm chọn).

## 2. Truyền video xuống trình duyệt

| Transport | Qua Cloudflare quick tunnel? | Latency | Độ phức tạp |
|---|---|---|---|
| **WS + H.264 Annex-B + WebCodecs → canvas** | ✅ (WS là HTTP) | ~80–200ms LAN, + RTT qua tunnel | Trung bình: tách NAL theo start-code, gửi SPS/PPS + keyframe khi client mới vào, `VideoDecoder` với `optimizeForLatency` |
| WS + MJPEG | ✅ | thấp nhưng băng thông khủng, 10–15fps | Rất thấp — chỉ để demo |
| WS + fMP4/MSE | ✅ | 0.5–2s (buffer MSE) | Thấp; PPM đã có transcode-stream, nhưng độ trễ không hợp để điều khiển |
| WebRTC (werift / node-datachannel) | ❌ cần UDP hoặc TURN riêng | tốt nhất (<100ms) | Cao; thêm server TURN, không chạy trên Bun ổn định (werift là Node-first) |

→ **Chọn WS + WebCodecs.** Safari iOS 16.4+ hỗ trợ VideoDecoder H.264 → mobile PPM dùng được. Firefox còn thiếu → fallback MJPEG hoặc báo "không hỗ trợ".

Gotcha đã biết trong repo (memory): Bun/Win segfault nếu đưa `proc.stdout` thẳng vào Response hoặc gọi `reader.cancel()` — phải bọc stream + `proc.kill()`; pattern này đã có trong `media-transcode/transcode-stream.ts`, tái dùng.

## 3. Điều khiển (input) — chỗ khó thật sự

- **Chuẩn Windows:** "không có cách được hỗ trợ để giả lập input cho chương trình không ở foreground" (SendInput docs + Old New Thing 2025-03-19).
- **Hệ quả thực tế:** mỗi lần client click → server phải `SetForegroundWindow(hwnd)` (có ràng buộc: tiến trình gọi phải đang có foreground hoặc được phép — thường phải dùng mẹo `AttachThreadInput`/`AllocConsole`) rồi `SendInput` với toạ độ đã map từ canvas → client-rect của cửa sổ. Chuột thật của host sẽ di chuyển.
- `PostMessage(WM_LBUTTONDOWN/WM_KEYDOWN)` trực tiếp vào HWND: chạy với app Win32 cổ điển đơn giản, **thất bại** với Chrome/Electron/UWP/game/anything dùng Raw Input hoặc kiểm tra `GetKeyState`. Không nên coi là giải pháp.
- Bun có `bun:ffi` → gọi `user32.dll` (`EnumWindows`, `GetWindowRect`, `DwmGetWindowAttribute` để lấy khung đúng, `SetForegroundWindow`, `SendInput`) trực tiếp, không cần node-gyp/nut.js (nut.js không có bản Bun ổn định; libnut-core còn dùng `SetCursorPos`).
- Bàn phím: map `KeyboardEvent.code` → Virtual-Key + scan-code, dùng cờ `KEYEVENTF_SCANCODE` để game/terminal nhận đúng. IME/tiếng Việt Unikey: dùng `KEYEVENTF_UNICODE` cho ký tự đã compose sẵn từ mobile keyboard.

**Nếu muốn "điều khiển nền" thật:** phải chạy app trong session khác (RDP loopback / Windows Sandbox / VM / virtual display kiểu Sunshine) — đổi hẳn bài toán, ngoài phạm vi câu hỏi.

## 4. Bảo mật

- Đây là **remote-control toàn quyền qua URL công khai** (tunnel). Chat AI trong PPM đã có quyền chạy lệnh, nhưng "chuột thật di chuyển" tăng rủi ro social-engineering/nhìn thấy dữ liệu trên màn hình.
- Đề xuất: bật theo phiên (session) có TTL, phải xác nhận lại mật khẩu PPM khi mở, badge đỏ "đang bị điều khiển từ xa" + nút kill ngay trên host (tray/notification), audit log, chỉ owner (không cho paired device của bot), rate-limit input WS, từ chối chụp khi Windows lock.
- Dùng lại `ppm-protected-pids` / kill-guard pattern để chặn điều khiển vào cửa sổ của chính PPM/console supervisor (tránh tự bắn chân).

## 5. Đề xuất triển khai (nếu quyết làm)

**Phạm vi MVP (Windows only, ~1 sprint):**
1. `GET /api/host/windows` — liệt kê cửa sổ top-level (title, pid, rect, icon) qua `bun:ffi` user32 (`EnumWindows`+`IsWindowVisible`+`GetWindowTextW`) — hoặc mở rộng PowerShell session sẵn có trong `system-metrics` (đã có 1 child PowerShell dài hạn; **không spawn per tick** — gotcha 32MiB).
2. `WS /ws/host-window/:hwnd` — spawn `ffmpeg -f gdigrab -framerate 30 -i title=… -c:v h264_nvenc -tune ull -zerolatency -g 60 -bf 0 -f h264 -` (fallback libx264 `-tune zerolatency`), tách NAL, đẩy binary frame; nhận JSON input event ngược lại.
3. Frontend: window kind mới `host-window` trong `floating-window/` (giống `system-monitor`), `VideoDecoder` → `<canvas>`, bắt pointer/keyboard, map toạ độ theo `devicePixelRatio` + rect cửa sổ, mobile: 2 ngón = chuột phải, pinch zoom canvas (theo `docs/design-guidelines.md`).
4. Input: `SetForegroundWindow` + `SendInput` qua `bun:ffi`; Unicode path cho ký tự.
5. Guard bảo mật ở mục 4 (re-auth + badge + audit).

**Phase 2:** thay gdigrab bằng native helper WGC (Rust `windows-capture` crate hoặc C# `Windows.Graphics.Capture`) → không lộ cửa sổ đè, GPU frame → pipe NV12 vào ffmpeg NVENC. **Phase 3:** macOS/Linux capture + input.

Ước lượng độ trễ MVP trên LAN: ~150–250ms (gdigrab ~30ms + NVENC ~10ms + WS + decode + vsync). Qua tunnel Cloudflare: + RTT ×1 (~50–150ms ở VN).

---

## Bản sửa sau khi user chốt yêu cầu (2026-09-05 11:24)

**User chốt:** (1) remote từ phone/máy khác để bấm vài nút PPM không tự làm được — **ấn Yes trong UAC**, login web service; (2) mọi OS; (3) được yêu cầu cài ffmpeg; (4) foreground/chuột thật di chuyển: sao cũng được.

### Hệ quả 1 — bỏ "theo cửa sổ", chuyển sang "cả desktop"
UAC dialog, hộp login, popup trình duyệt… không phải 1 cửa sổ cố định. Stream **cả màn hình** đơn giản hơn và đúng nhu cầu hơn: Windows dùng **ddagrab** (GPU, không có vấn đề cửa sổ đè), macOS `avfoundation "Capture screen 0"`, Linux `x11grab`. Input = `SendInput` toạ độ tuyệt đối, không cần `SetForegroundWindow`. Mục 1–3 ở trên vẫn đúng về transport (WS + WebCodecs) nhưng phần "per-window" không còn cần.

### Hệ quả 2 — UAC là **rào cản thật**, không phải chi tiết
UAC mặc định hiện trên **Secure Desktop** (desktop `Winlogon`, cùng chỗ với màn hình khoá). Tiến trình user bình thường:
- **không chụp được** (ddagrab/gdigrab/WGC trả về đen hoặc đóng băng khung cuối),
- **không gửi input được**: `SendInput` chịu UIPI — chỉ inject vào tiến trình có integrity **≤** mình; `consent.exe` chạy High/SYSTEM. PPM autostart hiện là `RunLevel=LeastPrivilege` (`autostart-generator.ts:254`) = Medium integrity → bị chặn.

Cùng một rào cản áp lên **màn hình khoá**: máy để không → lock → phone không thấy gì, không gõ được mật khẩu mở khoá. Với use case "remote lúc không ngồi tại máy" đây là tình huống thường gặp, không phải edge case.

**3 đường ra (Windows):**

| Đường | Cách | Được gì | Trả giá |
|---|---|---|---|
| **A. Tắt Secure Desktop + chạy PPM elevated** | Policy `HKLM\...\Policies\System\PromptOnSecureDesktop=0` (cần admin 1 lần); task autostart đổi `RunLevel=HighestAvailable` | UAC hiện trên desktop thường → chụp + click được. Đơn giản, không code native mới | Giảm bảo mật UAC của cả máy; PPM + mọi lệnh AI chạy đều là admin (không còn UAC luôn — xem C); **vẫn không qua được lock screen** |
| **B. Service SYSTEM + helper trong session** | Cách TeamViewer/RustDesk/AnyDesk làm: 1 Windows service chạy SYSTEM, `CreateProcessAsUser` 1 helper vào session người dùng với desktop `Winlogon` khi cần; helper chụp + `SendInput` trên secure desktop | Giải quyết đúng **cả UAC và lock screen** | Phải cài service (admin 1 lần), thêm 1 thành phần native (Rust/C#) ngoài Bun, bề mặt tấn công lớn: PPM qua URL public giờ có quyền SYSTEM trên máy. Nhiều việc nhất |
| **C. Né UAC thay vì bấm UAC** | Chỉ chạy PPM server elevated (`HighestAvailable`), không đụng Secure Desktop | Mọi tiến trình AI spawn kế thừa admin → **UAC không bao giờ xuất hiện**. 0 dòng code streaming cho mục UAC | Không có "cửa an toàn" nữa: AI cài gì cũng được không hỏi. Không giải quyết "login web", lock screen |

**Đề xuất:** làm streaming/điều khiển cả desktop (WS + WebCodecs + SendInput) như MVP dùng chung mọi OS; **cho UAC/lock screen thì đi đường A trước** (opt-in, PPM hướng dẫn user bật, có cảnh báo rõ) — vì B là một sản phẩm remote-desktop hoàn chỉnh, không phải 1 feature. Nếu sau này thấy cần lock-screen thật sự thì nâng lên B. C là lối tắt nếu chỉ vướng UAC do lệnh AI spawn.

### Hệ quả 3 — macOS / Linux
| OS | Chụp | Input | Rào cản tương đương UAC |
|---|---|---|---|
| macOS | `ffmpeg -f avfoundation -i "Capture screen 0"` (cần cấp **Screen Recording** cho tiến trình ppm/bun trong System Settings; lần đầu sẽ hiện prompt TCC ngay trên host) | `CGEventPost` qua `bun:ffi` → CoreGraphics (cần **Accessibility**) | Hộp xin mật khẩu admin (SecurityAgent) **chụp và click được** khi có 2 quyền trên. Lock screen: không (loginwindow). Sau khi cấp quyền, binary đổi (upgrade PPM) → macOS có thể huỷ quyền, phải cấp lại |
| Linux X11 | `x11grab` | XTest qua `xdotool` hoặc `bun:ffi` libXtst | polkit prompt là cửa sổ X thường → được. Lock screen: không |
| Linux Wayland | PipeWire portal (`xdg-desktop-portal`) — **bắt user bấm chọn trên host** mỗi lần; ffmpeg cần build có `pipewiregrab`/dùng `gst` | `ydotool` (uinput, cần quyền) hoặc libei | Khó nhất, đề xuất để phase cuối / chỉ hỗ trợ X11 trước |

### Phạm vi MVP điều chỉnh
1. `WS /ws/remote-desktop` — spawn ffmpeg theo OS (ddagrab / avfoundation / x11grab) → H.264 zerolatency (NVENC/QSV/VideoToolbox/libx264 tái dùng `encoderArgs`) → tách NAL → binary WS; nhận input JSON. Chọn monitor.
2. Frontend: window kind `remote-desktop` trong `floating-window/` (+ tab full-screen mobile), `VideoDecoder` → canvas; pointer/keyboard map toạ độ; mobile: chạm = click, 2 ngón = chuột phải, pinch zoom, thanh phím ảo (Esc/Tab/Ctrl/Alt/Win/⌘).
3. Input backend: `bun:ffi` → user32 `SendInput` (Win), CoreGraphics `CGEventPost` (mac), `xdotool` spawn (Linux X11). Bàn phím: scan-code + `KEYEVENTF_UNICODE` cho ký tự.
4. Windows: màn "Chuẩn bị" trong UI kiểm tra và hướng dẫn: ffmpeg có chưa, `PromptOnSecureDesktop`, RunLevel task; nút "bật chế độ Highest" chạy `schtasks` elevated (1 lần UAC tại máy).
5. Bảo mật: re-auth mật khẩu khi mở, TTL phiên, badge trên host, audit log, chặn paired-device/bot, từ chối khi lock (báo rõ "máy đang khoá, không thể điều khiển" thay vì khung đen).

Yêu cầu ffmpeg: đã chấp nhận → UI hiển thị lệnh cài (`winget install ffmpeg` / `brew install ffmpeg` / `apt install ffmpeg`) khi `Bun.which("ffmpeg")` null; macOS lưu ý build ffmpeg Homebrew có avfoundation, Linux distro build thường có x11grab.

---

## Bản chốt hướng đi (2026-09-05 11:34)

**User chốt:** đi thẳng **B** (service SYSTEM), nhưng **spike trước**.

### B giải quyết lock screen + UAC — xác nhận
B = mô hình TeamViewer/RustDesk/AnyDesk: 1 **Windows service chạy SYSTEM** thường trú; khi cần `CreateProcessAsUser` bơm helper vào **desktop đang active** (`WTSGetActiveConsoleSessionId` → `Winlogon`/default/secure). Service SYSTEM đủ integrity để chụp + `SendInput` trên secure desktop và lock screen. → UAC ✅, lock screen ✅, đăng nhập Windows từ xa ✅. Lock screen **không còn là vấn đề** với B.

### Spike phải chạy trên OS thật — KHÔNG Docker/WSL cho phần lõi
Rủi ro chính của B = cơ chế privileged "nhảy" từ SYSTEM sang desktop phiên đăng nhập. Cơ chế này chỉ tồn tại trên 1 OS session thật:
- Windows secure desktop: chỉ Windows thật / VM Windows. Docker & WSL **không có** secure desktop → không test được thứ cần test.
- Linux trong Docker: container không có seat/logind/display-manager → không có lock screen/polkit-trên-secure-context. Docker chỉ validate nửa dễ (chụp X11 + XTest trên desktop thường).

→ Docker/WSL **không phải fallback hợp lệ** cho phần privileged; chỉ dùng cho pipeline transport (ffmpeg→NAL→WebCodecs) không đặc quyền.

⚠️ **WSL bị loại** (memory `feedback_no-wsl`: user mất 3 tuần code do `wsl --unregister`, 05/2026, dặn không bao giờ dùng lại). Cần Linux sạch → **VM Linux thật** (Hyper-V/VirtualBox), không WSL.

### Thứ tự spike
| Spike | Môi trường | Chứng minh |
|---|---|---|
| **S1 Windows (ưu tiên 1)** | máy này | service SYSTEM → `CreateProcessAsUser` vào session → chụp + `SendInput` **bấm Yes trên UAC** + gõ mật khẩu **lock screen**. Toàn bộ giá trị B. |
| **S2 Linux X11** | VM Linux thật | root helper chụp X11 greeter/GDM + XTest bơm input trên polkit/greeter. X11 trước (đơn giản hơn Wayland). |
| Wayland | sau | portal + libei, phức tạp nhất. |
| (phụ) transport | Docker OK | ffmpeg→NAL split→WebCodecs decode, không privileged. |

### S1 — tiêu chí thành công (Windows, đo trên máy này)
1. Cài được Windows service SYSTEM (dev: `sc create` thủ công; sau tích hợp installer PPM).
2. Từ service, `CreateProcessAsUser` bơm helper vào active console session, verify helper chạy trên đúng desktop khi UAC bật (secure) và khi máy lock.
3. Helper chụp 1 khung khi **UAC consent.exe đang hiện** (chứng minh không phải khung đen) → gửi ra ngoài service qua named pipe/localhost.
4. Helper `SendInput` click toạ độ nút "Yes" trên UAC → prompt đóng. Gõ ký tự trên lock screen.
5. Đo latency chụp→hiển thị trên 1 client LAN.
6. Ghi lại: quyền cần (admin lúc cài), AV/EDR có chặn `CreateProcessAsUser`/service không, ổn định khi switch desktop.

Spike = mã throwaway ngoài luồng chính (đề xuất `spikes/remote-desktop-b/`), có thể C#/Rust (WGC + CreateProcessAsUser dễ nhất bằng C#/win32); quyết định ngôn ngữ helper native sau khi S1 xong. Chưa đụng `src/`.

### Quyết định cuối (2026-09-05 11:34)
- Helper native: **Rust** (`windows` crate) — 1 binary tĩnh, bundle vào PPM, dùng chung cho cross-OS về sau.
- S1: chạy trên **máy chính HIEN-PC** (UAC/AV thật). Chấp nhận rủi ro AV cảnh báo + tự dọn service sau spike.
- Sau spike: **chỉ báo cáo kết quả + khuyến nghị**, chưa lên plan/chưa đụng `src/`.
- S2 Linux: VM thật, không WSL.

### Cảnh báo trước khi chạy S1 (hành động khó đảo ngược)
S1 sẽ: cài 1 Windows service chạy SYSTEM (`sc create`, cần **admin** — sẽ có UAC tại máy), gọi `CreateProcessAsUser`, `SendInput` lên secure desktop. Rủi ro thực tế trên HIEN-PC: 4 driver anti-cheat + ASUS IOMap64 (memory `reference_gaming-pc-kernel-driver-clutter`) và AV có thể gắn cờ hành vi này như malware (đúng là kỹ thuật RAT hay dùng). Cần: chạy trong thư mục throwaway `spikes/remote-desktop-b/`, gỡ service ngay sau spike (`sc delete`), không commit binary. **Chờ user xác nhận "chạy spike" trước khi bắt đầu** (research xong tới đây là hết phạm vi `/ak:research`).

## Câu hỏi chưa chốt

1. Bắt đầu S1 ngay bây giờ chứ? (cần cài Rust toolchain nếu chưa có: `rustup`; và 1 lần UAC để `sc create`.)
2. Rust toolchain đã có trên HIEN-PC chưa (`rustc --version`)? Nếu chưa, đồng ý cài `rustup` chứ?

## Nguồn

- [FFmpeg gdigrab.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavdevice/gdigrab.c) · [PinballY: gdigrab vs ddagrab](http://mjrnet.org/pinscape/downloads/PinballY/Help/CaptureFfmpegOptions.html) · [FFmpeg screen recording cookbook](https://ffmpeg-cookbook.com/en/articles/screen-recording/) · [MS Learn: Screen capture (WGC)](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)
- [SendInput (MS Learn)](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) · [Old New Thing 2025-03-19: You can't simulate keyboard input with PostMessage, revisited](https://devblogs.microsoft.com/oldnewthing/20250319-00/?p=110979) · [libnut-core #26 SendInput](https://github.com/nut-tree/libnut-core/issues/26)
- [werift-webrtc](https://github.com/shinyoshiaki/werift-webrtc) · [Cloudflare Stream WebRTC](https://developers.cloudflare.com/stream/webrtc-beta/) · [awesome-webrtc](https://github.com/nuzulul/awesome-webrtc)
- [linckosz/moonlight-web](https://github.com/linckosz/moonlight-web) · [MrCreativ3001/moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) · [moonlightweb.top FAQ](https://moonlightweb.top/faq.html)
- [selkies-project/selkies](https://github.com/selkies-project/selkies) · [Selkies design](https://selkies-project.github.io/selkies/design/) · [Open source self-hosted remote desktop 2026](https://computingforgeeks.com/best-open-source-remote-desktop-tools/) · [RustDesk overview 2026](https://www.blog.brightcoding.dev/2026/03/19/rustdesk-the-self-hosted-remote-desktop-revolution)
- Nội bộ: `src/services/media-transcode/ffmpeg-capabilities.ts`, `src/services/system-metrics/powershell-session.ts`, `src/web/components/floating-window/`, memory `project_bun-subprocess-stdout-response-segfault`, `project_cloudflare-tunnel-no-disconnect-propagation`.
