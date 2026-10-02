# Phase 0 report — Android Emulator trong PPM

Ngày: 2026-09-21. Đối chiếu plan: `docs/architecture/android-emulator-plan-260920.md`.
Spike: `spikes/android/` (không nằm trong build, không ship).

## 1. Kết luận cổng (gate)

Plan §9 đặt gate Phase 0 là: *"boot/stream/control/cleanup thật và ngân sách sơ bộ đạt"*.

**Phần đã đo: đạt.** Boot, stream, control và cleanup đều chạy thật trên host Linux này, và mọi
chỉ số đo được đều nằm trong ngân sách §10 — phần lớn là cách ngân sách một quãng rộng.

**Phần chưa đo: click-to-visible, LAN/tunnel, reconnect, soak.** Bốn mục này đều cần một viewer
trong trình duyệt mà Phase 0 không dựng. Chúng **chưa được chứng minh**, không phải đã đạt.

Quan trọng hơn cả các con số: hai giả định trong plan sai, và ba thứ plan không biết đã xuất
hiện — trong đó có một thứ làm bàn phím chết im lặng.

## 2. Môi trường đo

| Thành phần | Phiên bản |
|---|---|
| Host | Linux 7.2.6 CachyOS, i9-12900K (24 luồng), Intel UHD 770, 62 GiB RAM |
| Bun | 1.3.11 |
| Android emulator | 36.5.10.0, build 15081367 |
| adb | 1.0.41 (37.0.0-android-tools) |
| ffmpeg | n9.0.1 |
| `@grpc/grpc-js` | 1.14.0 |
| `@grpc/proto-loader` | 0.7.15 |
| AVD test | `ppm_spike_test`, API 35 `google_apis_playstore_tablet` x86_64, pixel_6, 1080x2400 @420dpi |
| GPU emulator | `swiftshader_indirect` (phần mềm) |

AVD test do task tạo trong `ANDROID_AVD_HOME=/home/thawngho/.android-spike-avd`. `Pixel_9` và
`Pixel_Tablet` của người dùng **không bị đụng**; đã verify cả hai chiều: emulator chỉ thấy AVD
spike khi biến môi trường được set, và chỉ thấy AVD người dùng khi không.

## 3. ADR-A — gRPC dưới Bun: **đạt**

| Phép đo | Kết quả |
|---|---|
| `getStatus` lần đầu (gồm bắt tay HTTP/2) | 1617.9 ms |
| `getStatus` steady-state, 50 lần | p50 **0.68 ms**, p95 1.32 ms, max 1.95 ms |
| `getScreenshot` RGB888 full-res | 7.776.000 byte (đúng `1080×2400×3`) trong 21.3 ms |
| `getDisplayConfigurations` | OK, 1 display, `maxDisplays: 11` |
| Deadline unary | Fire đúng, `DEADLINE_EXCEEDED` |
| Cancel stream | `CANCELLED`, **0 frame giao sau `cancel()`** |
| 25 vòng create/cancel | Emulator vẫn trả lời, client đóng sạch |

p50 0.68 ms nghĩa là đường **input** qua grpc-js gần như không tốn gì. Không cần lo phần này.

### Compiled binary: hỏng theo cách đã đoán trước, và đã sửa

Chạy binary `bun build --compile` từ thư mục ngoài checkout:

```
ENOENT  at loadProtosWithOptionsSync (/$bunfs/root/spike-naive:23060:37)
```

`@grpc/proto-loader.loadSync()` đọc file `.proto` từ đĩa lúc chạy; trong binary đường dẫn trỏ vào
`/$bunfs/root/` nên không có file. Đây đúng bài học "compiled PPM không với tới node_modules của
chính nó" trong CLAUDE.md, và nó xác nhận quyết định *"build-time generate"* của ADR-A bằng một
thất bại đo được chứ không phải suy luận.

Cách sửa đã chứng minh: `bun gen-proto-json.ts` sinh descriptor JSON (48 KiB) → `import` vào module
→ `protoLoader.fromJSON()`. Sau đó binary chạy từ `/tmp/.../elsewhere` với `getStatus` 17.5 ms, và
toàn bộ bài cancellation/deadline/cleanup pass **giống hệt bản chạy từ source**.

→ **`loadSync` không được phép xuất hiện trong code PPM.** Chỉ `fromJSON` với descriptor nhúng.

## 4. ADR-B — media: đo xong, và nghi ngờ lớn nhất về nó là **sai**

Plan tính 720p30 RGB = 83 MB/s và lo grpc-js không kham nổi. Đo thật, với chuyển động liên tục
(stopwatch đang chạy — xác minh 8/8 frame khác nhau trước khi đo):

| Cấu hình | fps | Băng thông | gap p50/p95/max | Rớt frame |
|---|---|---|---|---|
| RGB888 720×1600 | 39.9 | 131.9 MiB/s | 26.7 / 37.8 / 45.8 ms | **0** |
| RGB888 1080×2400 | 40.0 | **297.4 MiB/s** | 23.2 / 39.1 / 45.9 ms | **0** |
| MMAP 720×1600 | 39.8 | **0 byte qua gRPC** | 23.7 / 37.9 / 48.3 ms | 0 |

grpc-js dưới Bun tải được **297 MiB/s** ở full-res mà không rớt frame nào (seq liên tục 1..398).
Ngưỡng 83 MB/s mà plan lo không phải là ngưỡng.

**Màn hình tĩnh thì gần như miễn phí**: 2.1 fps, gap đều 500 ms, không rớt frame. Emulator chỉ gửi
khi khung hình đổi, cộng một nhịp giữ 500 ms. Rất hợp với ngân sách "Idle/ẩn" §10.

> Cảnh báo cho người đo sau: đo trên màn hình tĩnh cho ra **2 fps** và trông y như một giới hạn
> cứng của `streamScreenshot`. Không phải. Swipe rời rạc cũng không đủ — nó chỉ tạo hai trạng thái
> (đo được: 2/8 frame khác nhau). Phải có nguồn động thật; stopwatch của app Clock là nguồn rẻ nhất.

### Pipeline đầy đủ gRPC RGB → ffmpeg → H.264

720×1600@30, cap 4 Mbit/s, 12 giây: 359 frame vào ffmpeg, **`ffprobe` đọc ra đúng 360 frame**,
h264/yuv420p, bitrate **3.90 Mbit/s** — nằm trong mục tiêu 2–6 Mbps của §10.

| Encoder | CPU ffmpeg | RSS | Bitrate | Frame decode |
|---|---|---|---|---|
| `libx264` veryfast/zerolatency | 64–80% một core (tăng dần) | ~103 MB | 4.10 Mbit/s | 390 |
| **`h264_vaapi`** | **33.1–33.6%** (phẳng) | ~97 MB | 4.03 Mbit/s | 390 |

VAAPI dùng **nửa CPU**, phẳng, cùng bitrate, cùng số frame. Cả `h264_vaapi` và `h264_qsv` chạy được
trên Intel UHD 770 này. Lưu ý `ffmpeg -encoders` cũng liệt kê `h264_amf` và `h264_nvenc` trên máy
Intel — đúng lý do `workingEncoders()` phải test-encode thật thay vì đọc danh sách.

### Quyết định ADR-B

**Giữ option 1 (gRPC RGB → ffmpeg → H.264) làm đường chính.** Không cần chuyển sang scrcpy.
Lý do là số đo, không phải sở thích: throughput dư 3–4 lần, không rớt frame, input latency p50
dưới 1 ms, và pipeline đã cho ra stream H.264 decode được đúng số frame.

**MMAP để dành, chưa dùng ở v1.** Nó chạy và đưa pixel ra khỏi gRPC hoàn toàn, nhưng fps không
đổi vì gRPC vốn đã không phải nút thắt. Nó là đòn bẩy để giảm CPU/bộ nhớ khi có nhiều máy cùng
chạy, và proto tự cảnh báo *"the mmap can result in tearing"*. Đưa vào khi có lý do đo được.

## 5. Ba thứ plan không biết

### 5.1 `ImageTransport.MMAP` — ADR-B thiếu hẳn một phương án

`emulator_controller.proto` field 6 cho **client sở hữu** một handle shm/mmap để emulator ghi frame
vào; gRPC khi đó chỉ mang metadata (`seq`, `timestampUs`). Đo được: 318/318 frame có pixel thật
trong buffer chung, **0 byte** pixel đi qua gRPC. Bảng phương án của ADR-B nên có thêm dòng này.

### 5.2 Emulator tự scale phía server — nhưng là **hộp bao**, không phải kích thước yêu cầu

`ImageFormat.width/height` làm emulator scale **trước khi gửi**: xin 720×1600 trả về đúng
720×1600 (3.456.000 byte, khớp chính xác). Không cần gửi full-res rồi scale ở host. Plan không nói.

**Đính chính ở Phase 2:** trả đúng 720×1600 là vì con số đó khớp tỉ lệ của thiết bị. Proto nói rõ
hơn thế: *"The returned image will never exceed the given width, but can be less"*, scale *"while
maintaining the aspect ratio of the device"* — tức đây là **hộp bao**, không phải kích thước ra
lệnh. Hai hệ quả: (1) phải xin hộp **vuông** `H×H` để trần áp lên cạnh dài, nếu không một guest
xoay ngang lọt vào hộp dọc sẽ teo lại còn một dải mỏng; (2) kích thước thật phải đọc từ
`format.width/height` của **chính frame** (là trường output), không được giả định — và đó cũng là
thứ làm việc xoay màn hình chạy đúng mà không phải đoán.

### 5.3 ~~Thứ tự pixel là **bottom-up**~~ — **SAI, đã đo lại ở Phase 2**

Mục này từng ghi: *proto nói "from left to right and bottom up", nên chuỗi filter ffmpeg phải có
`vflip`*. Đó là **chép lại comment trong proto, chưa từng đo**. Phase 2 đo trực tiếp bằng cách so
từng hàng buffer gRPC với `adb exec-out screencap` (ảnh này chắc chắn top-down):

| căn hàng | chênh lệch trung bình / pixel |
|---|---|
| `grpc[y]` ↔ `screencap[y]` | **1.21** |
| `grpc[y]` ↔ `screencap[h-1-y]` | **37.15** |

Trên emulator 36.5.10 buffer là **top-down**. Thêm `vflip` sẽ làm **mọi màn hình lộn ngược**, và
không có lỗi nào báo. Đã bỏ khỏi `encoderArgs`; `tests/e2e/android-e2e.ts` giữ lại phép so này làm
chốt chặn hồi quy, phòng khi một bản emulator sau này đúng là bottom-up thật.

Bài học chung: một câu trong tài liệu vendor không phải là phép đo.

### 5.4 Toạ độ `sendTouch` là **panel gốc chưa xoay** (đo ở Phase 2)

Proto chỉ nói *"the physical location on the screen"*. Đo bằng `getevent` trên chính guest: màn
hình cảm ứng báo dải tuyệt đối 0..32767, và toạ độ gửi vào được chuẩn hoá theo kích thước
**panel** (`hw.lcd.width` × `hw.lcd.height`) — gửi x=2000 trên panel rộng 1080 cho ra 60679, tức
2000/1080 toàn thang, vượt dải và bị kẹp. Điều này **không đổi khi xoay**, nên frame đã xoay phải
được xoay ngược lại trước khi gửi. Chiều xoay đo riêng cho từng hướng bằng cách chạm vào một điểm
panel đã biết với `show_touches`, rồi tìm dấu chạm trong frame; mỗi hướng thắng phương án nhì cách
biệt một bậc (90°: 0.040 so với 0.449; 180°: 0.003 so với 0.433; 270°: 0.080 so với 0.420).

### 5.5 Stream ảnh **không mở lại được sau khi cancel** (đo ở Phase 2)

Sau khi `streamScreenshot` bị cancel, mọi stream mở sau đó trả **đúng 1 frame** rồi im — kể cả
trên channel gRPC mới. Hệ quả thiết kế: đổi mức chất lượng **không được** đóng/mở lại stream. PPM
mở đúng một stream ở trần rung cao nhất cho cả phiên và đổi rung bằng `scale` trong ffmpeg.

## 6. Hai chỗ plan nói sai

### 6.1 §7 — plan đúng, bản nháp report này từng ghi sai

Bản đầu của report kết luận "không có kiểm tra Origin nào cả". **Sai, do grep thiếu thư mục.**
Lần quét đầu chỉ có `src/server/ws/`, `src/server/middleware/` và `src/server/index.ts`, bỏ sót
`src/server/routes/`. Kiểm tra đó nằm ở `src/server/routes/remote-desktop.ts:28-46`
(`assertSessionAllowed`), và đúng là **hostname-only** như plan mô tả — có chủ ý, có comment: dev
proxy của Vite ghi đè `Host` mà không thêm `X-Forwarded-Host`, nên so cả `host:port` sẽ chặn mọi
phiên chạy ở chế độ dev. `named-tunnel.ts` và `accounts.ts` cũng có bản sao của khuôn này.

Nên §7 của plan giữ nguyên, và lời cảnh báo của nó vẫn đáng giá: dùng lại khuôn đó thì được, nhưng
nó **không** phải bảo đảm same-origin đầy đủ — một trang khác **port** trên cùng hostname vẫn qua.

### 6.2 §12 — Unicode qua gRPC: câu trả lời là **không**

Đo với bàn phím hoạt động, ô nhập đã focus, re-verify focus trước từng lần gõ:

| Gửi | Nhận | |
|---|---|---|
| `text: "hello"` | `hello` | INTACT |
| `key` h,e,l,l,o | `hello` | INTACT |
| `text: "café"` | **`caf`** | ký tự có dấu bị nuốt im lặng |
| `text: "Tiếng Việt"` | `""` | mất sạch |
| `text: "😀"` | `""` | mất sạch |
| `text: "日本語"` | `""` | mất sạch |

Proto tự ghi giới hạn này (*"only printable ASCII [32-127)"*), và đo khớp. Kiểu hỏng là tệ nhất:
**không lỗi, chỉ cắt cụt âm thầm**.

`setClipboard` thì giữ nguyên `"Tiếng Việt 😀"` — xác minh cả bằng round-trip API lẫn bằng mắt
(chip gợi ý clipboard của Android hiện đúng chuỗi kèm emoji trong guest).

→ **E2E case 3 của plan không thể đạt bằng `sendKey`/`text`.** Toàn bộ chuyện gõ tiếng Việt và
IME mobile ở §6 phải xây trên đường clipboard, không phải trên `text`.

## 7. Bẫy vận hành phát hiện khi đo

**`hw.keyboard=no` là mặc định của `avdmanager`, và nó giết bàn phím trong im lặng.**
Đây là thứ tốn nhiều thời gian nhất của Phase 0. Triệu chứng: gRPC touch chạy hoàn hảo, gRPC
`sendKey` trả `OK` và **không có tác dụng gì**; `adb shell input text` thì vào bình thường.
Không phải allowlist (allowlist sẽ trả `PERMISSION_DENIED`), không phải `-no-window` (đã boot lại
với `-qt-hide-window`, y hệt). Nguyên nhân là một dòng trong `config.ini`:

| AVD | `hw.keyboard` |
|---|---|
| tạo bằng `avdmanager` | **`no`** |
| tạo bằng Android Studio | `yes` |

Lật thành `yes` rồi boot lại: cả ba đường (`key`, keydown/keyup, evdev `keyCode`) chạy ngay.
→ Phase 4 (tạo AVD) **bắt buộc** ghi `hw.keyboard=yes`; plan §9 Phase 4 hiện không nhắc.

**`-grpc <port>` tắt JWT.** `emulator -help` ghi `-grpc-use-jwt ... (default, disable with -grpc
flag)`. Ghim port cố định = tự hạ kênh điều khiển xuống không xác thực, trái §7. Luôn discovery.
Thực tế trên máy này gRPC bật sẵn không cần cờ nào: `Started GRPC server at 127.0.0.1:8554,
security: Local, auth: +token`, và emulator tự cảnh báo *"Basic token auth should only be used by
android-studio"* → PPM không phải Studio, đường đúng là JWT.

**`ANDROID_AVD_HOME` thay thế chứ không cộng dồn.** Set nó thì AVD của người dùng biến mất khỏi
`-list-avds`. Plan §5 nói "tôn trọng AVD home overrides" nhưng không nói chiều này: PPM **không**
được set biến này toàn cục.

**`Touch.pressure` phải về 0 khi nhả.** Proto: identifier không nhận pressure 0 thì không được giải
phóng. Emulator có lưới an toàn riêng — `EventExpiration` mặc định **120 giây** — nhưng 120 s quá
dài cho UX, nên timeout phía PPM ở §6 vẫn cần và phải ngắn hơn nhiều.

**Dừng máy bằng `setVmState SHUTDOWN`** qua gRPC: pid biến mất sau 1–3 giây. Không cần kill theo
tên process. Nhân tiện xác nhận cảnh báo của plan là thật: `pgrep qemu-system` trên máy này bắt
trúng **Docker Desktop**.

## 8. Hai bẫy pipeline, cả hai đã tái hiện được

**Pacing phải tính theo deadline tích luỹ.** Đẩy mọi frame rồi để `-vf fps=30` lọc là lãng phí
(đo: 318 frame đẩy vào để ra 240). Nhưng cách pace hiển nhiên — "đã qua một chu kỳ kể từ frame
nhận cuối chưa" — biến nguồn 40 fps thành **20 fps** ở mục tiêu 30 fps: frame sau đến ở 25 ms bị
loại, frame kế tiếp lấy ở 50 ms. Đo được 242 frame trong 12 giây thay vì 360. Phải dùng
`nextDue = max(now, nextDue + interval)`; sửa xong ra đúng 360.

**Bun `FileSink.write()` chỉ buffer.** Nó trả về số byte ngay lập tức, nên một vòng lặp ghi tự nó
không chứng minh được gì đã tới ffmpeg; `flush()` mới đẩy. Ghi nhận trung thực: sau khi đã ghi
đúng bội số nguyên của frame (`remainder 0`, kiểm bằng bộ đếm byte) ffmpeg **vẫn** báo
`Invalid buffer size ... packet size N < expected frame_size M` ở cuối stream. Thêm 1500 ms drain
không hết, phần dư còn to hơn — nên giả thuyết "Bun vứt buffer khi `end()`" là **sai**. Đây là
artifact lúc đóng: nguồn 40 fps nhanh hơn ffmpeg 30 fps nên pipe còn tồn đọng khi close.
`ffprobe` xác nhận stream ra đủ 360/360 frame, không frame nào hỏng. Pacing làm nó nhỏ đi nhiều.
**Chưa truy đến tận cùng**; nếu về sau ghi log ffmpeg cho người dùng thì phải xử lý dòng này,
đừng để nó trông như lỗi.

## 9. Chưa đo — không được coi là đã đạt

| §10 | Trạng thái |
|---|---|
| fps khi chuyển động | ✅ 39.9–40.0 |
| bitrate 2–6 Mbps | ✅ 3.90–4.13 Mbit/s |
| first frame ≤3 s | ✅ 29–59 ms |
| CPU ≤1 core / RSS ≤250 MiB | ✅ VAAPI 0.33 core, 97 MB |
| idle dừng feed | ✅ 2 fps màn hình tĩnh |
| **LAN input-to-visible p95 ≤150 ms** | ❌ chưa đo |
| **Tunnel p95 ≤300 ms** | ❌ chưa đo |
| **Reconnect ≤5 s** | ❌ chưa đo |
| **Soak 60 phút** | ❌ chưa đo |
| **Ảnh hưởng chat/terminal** | ❌ chưa đo |
| Windows / macOS | ❌ chưa đo, máy này chỉ chứng minh Linux |
| Trình duyệt thật (Safari/Chrome mobile) | ❌ chưa đo |

Bốn mục đầu đều cần viewer trong trình duyệt. Chúng nên là điều kiện vào Phase 2, không phải thứ
bỏ qua.

## 10. Việc phải sửa trong plan trước khi sang Phase 1

1. **§7**: không cần sửa — plan đúng. (Bản nháp report này từng ghi ngược lại vì grep thiếu
   `src/server/routes/`; đã đính chính ở §6.1.)
2. **§12 + §6 + E2E case 3**: ghi Unicode qua `sendKey.text` là **không khả dụng**; đường tiếng Việt
   và IME mobile phải là clipboard.
3. **ADR-B**: thêm `ImageTransport.MMAP` vào bảng phương án; ghi quyết định giữ option 1 kèm số đo;
   thêm ghi chú scale server-side và pixel bottom-up.
4. **§9 Phase 4**: bắt buộc `hw.keyboard=yes` khi tạo AVD.
5. **§5**: ghi `-grpc <port>` tắt JWT nên luôn discovery; ghi `ANDROID_AVD_HOME` thay thế chứ không
   cộng dồn.
6. **ADR-A**: ghi rõ cấm `protoLoader.loadSync`, chỉ `fromJSON` + descriptor sinh lúc build.

## 11. Tái lập

```bash
cd spikes/android
bun install
ANDROID_AVD_HOME=... DISPLAY=:0 WINDOW_MODE=qt-hide-window ./boot-test-avd.sh &
bun discovery.ts          # endpoint + auth từ file discovery
bun smoke-getstatus.ts    # ADR-A: gRPC dưới Bun
bun verify-rpcs.ts        # latency, screenshot PNG/RGB888, scale server-side
bun focus-search.ts       # toạ độ chạm, đọc bounds thật từ uiautomator
bun text-injection.ts     # giới hạn Unicode
W=720 H=1600 bun bench-stream.ts     # cần chuyển động thật trên màn hình
W=720 H=1600 bun bench-mmap.ts
ENC=h264_vaapi W=720 H=1600 FPS=30 OUT=/tmp/o.h264 bun bench-encode.ts
bun verify-cancel.ts      # deadline / cancel / cleanup
bun gen-proto-json.ts && bun build --compile --outfile /tmp/s smoke-getstatus.ts
bun stop-emulator.ts      # graceful, không kill theo tên
```

Dọn dẹp: `bun stop-emulator.ts`, rồi xoá `/home/thawngho/.android-spike-avd` và
`/tmp/ppm-android-spike`. Spike có khởi động adb daemon (trước đó chưa chạy).
