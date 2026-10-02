# Phase 2 report — Viewer tab với điều khiển đầy đủ

Ngày: 2026-09-21. Cổng Phase 1 đã qua (xem `android-emulator-phase0-report-260921.md` cho Phase 0).
Bản này ghi **những gì đo được**, đặc biệt là ba chỗ Phase 0 và plan nói sai, và các quyết định
thiết kế bị chính phép đo ép phải đổi.

## 1. Kết quả

| | |
|---|---|
| E2E mức dịch vụ (`tests/e2e/android-e2e.ts`) | **20/20**, lặp lại 3 lần đều pass |
| E2E qua server thật (`tests/e2e/android-ws-e2e.ts`) | **18/18** |
| Unit | 56 test Android (7 file), toàn bộ `tests/unit/web` + `tests/unit/android` 1542 pass |
| `tsc --noEmit` | 0 lỗi |
| `bun run build:web` | chunk riêng `android-tab-*.js`, 18.65 kB (gzip 6.23) |

Thông lượng đo trên emulator 36.5.10, guest 1080×2400, host Intel UHD 770 + `h264_vaapi`:

| | |
|---|---|
| Stream nguồn gRPC | **~55 fps, 864×1920, ~260 MiB/s**, giữ nguyên suốt 45 s không tụt |
| Sau pacing 24 fps (rung `low`) | fed 192 frame / 8 s — đúng bằng mục tiêu |
| Access unit ra | 199 / 8 s |
| Keyframe | 14 / 8 s ở GOP nửa giây |
| Codec | `avc1.64081f`, suy từ SPS thật |

## 2. Ba chỗ tài liệu nói sai, và cái giá nếu tin theo

### 2.1 `vflip` — plan và Phase 0 đều sai

Cả hai ghi *"thứ tự pixel là bottom-up nên chuỗi filter phải có `vflip`"*. Cả hai **chép từ comment
trong proto**, không đo. So từng hàng buffer gRPC với `adb exec-out screencap` (top-down chắc chắn):

| căn hàng | chênh lệch trung bình / pixel |
|---|---|
| `grpc[y]` ↔ `screencap[y]` | **1.21** |
| `grpc[y]` ↔ `screencap[h-1-y]` | **37.15** |

Buffer **top-down**. `vflip` sẽ làm mọi màn hình lộn ngược, không lỗi, không log. Đã bỏ. Phép so
này giữ lại trong `android-e2e.ts` làm chốt hồi quy — hai ảnh phải chụp lúc màn hình **đứng yên**,
nếu đang cuộn thì biên độ tụt xuống mức nhiễu (đo được: 217 so với 232, so với 1.5 so với 247 khi
đứng yên).

### 2.2 `ImageFormat.width/height` là hộp bao, không phải kích thước ra lệnh

Phase 0 kết luận "xin 720×1600 trả đúng 720×1600". Đúng, nhưng vì con số đó **khớp tỉ lệ thiết bị**.
Proto nói rõ: *"will never exceed the given width, but can be less"*, giữ nguyên tỉ lệ. Hai hệ quả:

- Hộp phải **vuông** (`H×H`), để trần áp lên **cạnh dài**. Hộp dọc 720×1600 với một guest xoay
  ngang cho ra 720×324 — mất gần hết độ phân giải đúng lúc người dùng xoay máy.
- Kích thước thật đọc từ `format.width/height` của **chính frame** (trường output), không giả định.
  Đây cũng là thứ khiến xoay màn hình chạy đúng mà không phải đoán gì: `format.rotation` đi kèm.

### 2.3 Stream ảnh không mở lại được sau khi cancel

Thiết kế đầu của pipeline đổi rung bằng cách cancel stream rồi mở lại với hộp mới. Đo:

| | frame nhận được |
|---|---|
| stream đầu tiên | bình thường (7 frame / 4 s màn hình ít đổi) |
| mở lại ngay trên cùng channel | **1** |
| mở lại sau 500 ms | **1** |
| mở lại trên **channel gRPC mới** | **1** |

Một stream đã cancel không thay thế được trên emulator 36.5.10. Thiết kế đổi thành: mở **đúng một**
stream ở trần rung cao nhất (`STREAM_BOX = 1920`) cho cả phiên, đổi rung là `scale=W:H` trong ffmpeg
cộng một encoder mới. Kết quả tốt hơn thiết kế cũ ở hai điểm khác nữa — không còn cửa sổ mất hình
lúc chuyển, và không còn một lớp trạng thái emulator để hỏng.

Chi phí: rung thấp vẫn nhận 864×1920 qua gRPC rồi mới scale xuống. Đo được là thừa sức — nguồn giữ
260 MiB/s trong khi `h264_vaapi` chỉ tốn 0.33 core.

## 3. Toạ độ chạm — đo bằng `getevent`, không suy luận

`Touch.x/y` trong proto chỉ ghi *"the physical location on the screen"*. Đọc thẳng từ input device
của guest:

- Màn hình cảm ứng báo dải tuyệt đối **0..32767**, nên con số ở `getevent` là toạ độ đã chuẩn hoá.
- Gửi (200, 2000) trên panel 1080×2400 → `X=6067 Y=27305`, khớp `200/1080` và `2000/2400` toàn thang.
- Gửi x=2000 trên panel rộng 1080 → **60679**, tức `2000/1080` toàn thang: vượt dải, bị kẹp. Vậy
  đơn vị là **pixel panel gốc**, và **không đổi khi xoay**.

Chiều xoay đo riêng từng hướng: bật `show_touches`, chạm vào một điểm panel đã biết, tìm dấu chạm
trong frame bằng **trung vị** các pixel đổi màu. Mỗi hướng thắng phương án nhì cách biệt một bậc:

| hướng | phép biến đổi frame → panel | sai số | phương án nhì |
|---|---|---|---|
| 0° | `pu=fu, pv=fv` | ~0.006 | — |
| 90° | `pu=1−fv, pv=fu` | 0.040 | 0.449 |
| 180° | `pu=1−fu, pv=1−fv` | 0.003 | 0.433 |
| 270° | `pu=fv, pv=1−fu` | 0.080 | 0.420 |

Kiểm lại qua đường thật: frame(320,432) của 1280×576@90 → `frameToDevice` cho panel(270,600) →
`getevent` báo 8191/8191, mong đợi 8192/8192.

Hai bẫy trong chính phép đo này, đáng ghi vì đều làm ra kết quả *trông như đúng*:

- Điểm dò đầu tiên là (900, 2000) trên panel 1080×2400. `900/1080 == 2000/2400 == 5/6`, nên hai
  trục cho **cùng một con số** và một vụ đảo trục sẽ vô hình. Điểm dò phải lệch tỉ lệ ở hai trục.
- Trung bình cộng bị kéo đi bởi bất cứ thứ gì nhấp nháy ở góc màn hình (đồng hồ). Lần đo đầu cho
  0.5 ở mọi hướng — tức là đo cái đồng hồ. **Trung vị** mới ra kết quả.

## 4. `streamScreenshot` là stream **theo thay đổi**

> **Đính chính 2026-09-21.** Câu "không phải lỗi" bên dưới là sai, và chính cách đóng khung đó đã
> để lọt một lỗi thật: sự kiện này được coi là chuyện của *phép đo* chứ không phải của *sản phẩm*.
> Pipeline chỉ nạp ffmpeg khi có khung mới, nên trên màn hình đứng yên luồng H.264 im hẳn và người
> mở viewer lúc đó kẹt ở "Waiting for the first frame…" cho tới khi guest có gì đó động đậy. Đã
> sửa: nạp lại khung cuối theo nhịp fps của rung (`feedNow` + pacer trong `android-video.ts`), GOP
> nửa giây nên người vào xem máy đứng im có keyframe trong vòng 500 ms. Đo trên máy thật, không
> một thao tác nào: **143 khung, 10 keyframe trong 6 giây**. E2E cũ không thấy vì mọi kiểm tra đều
> chạy kèm vòng swipe liên tục — nay `android-ws-e2e.ts` tắt vòng đó rồi mới nối viewer C.

Không phải lỗi, nhưng làm hỏng mọi phép đo nếu không biết: màn hình đứng yên gần như không sinh
frame, màn hình **đã tắt** thì không sinh frame nào. Một lần chạy e2e báo 0 access unit trong 8 s
với pipeline hoàn toàn khoẻ — nguyên nhân là một cú chạm dò toạ độ đã **mở Play Store**, mà không
có mạng thì đó là một bức ảnh tĩnh. `android-e2e.ts` vì thế phải: đánh thức guest, ghim `stayon`,
đưa về launcher trước mỗi phép đo, và cuộn màn hình trong lúc đo. Khi số frame nguồn không nhúc
nhích, nó in luôn cửa sổ đang focus — dòng đó là thứ đã giải được vụ này.

## 5. Quyết định thiết kế

| Quyết định | Lý do |
|---|---|
| Một pipeline **cho mỗi thiết bị**, nhiều viewer dùng chung | Người xem thứ hai không được tốn thêm một stream gRPC và một ffmpeg cho cùng số pixel |
| Lease điều khiển theo **socket**, heartbeat 5 s / hết hạn 15 s | Hai người cùng chạm vào một guest không phải là tính năng. Máy gập nắp mất lease nhưng **vẫn xem được** |
| `sessionGeneration` và `geometryGeneration` tách nhau | Một cái trả lời "client này còn được điều khiển không", cái kia "toạ độ này còn mô tả màn hình đang có không" |
| Chuỗi codec `avc1.PPCCLL` suy từ **SPS thật**, gửi bằng message riêng | `encoderArgs` không đặt profile/level nên giá trị là mặc định của encoder, chỉ biết khi có bitstream. Đoán sai thì `configure()` ném lỗi |
| Backpressure: **một** ngưỡng, không có thang | `ws.getBufferedAmount()` là hàng đợi userspace của Bun, đã đo là gần như bất động kể cả ở 0.4 Mbit/s qua relay thật (CLAUDE.md). Xây thang trên tín hiệu đó là xây trên cát |
| Bàn phím đi qua **hidden textarea**, không qua `keydown` | IME gõ tiếng Việt gộp nhiều phím thành một ký tự; đọc `keydown` sẽ ra "Tieesng". Bàn phím ảo điện thoại không báo key code nào cả |
| Chữ không phải ASCII đi qua **clipboard** | Phase 0 đo: `sendKey.text` im lặng nuốt mọi ký tự ngoài [32,127) |
| Tab, không phải cửa sổ nổi như Remote Desktop | Chỉ có một desktop host để điều khiển, nhưng có thể có nhiều AVD, và người ta xem máy ảo **cạnh** code đang sửa |
| Tính năng **tắt mặc định** | Nó dựng một máy ảo. Một máy có sẵn Android SDK không có nghĩa là người dùng đã đồng ý cho PPM chạy emulator trên đó |

## 6. Chưa đo — không được coi là đã đạt

Giống mục 9 của Phase 0, phần này để tránh tự tin quá mức:

- **Độ trễ chạm-đến-thấy** p50/p95, trên LAN và qua tunnel. Chưa đo lần nào.
- **Reconnect ≤ 5 s** theo §10 của plan: đã có backoff và có `ready` sau khi nối lại, nhưng chưa
  bấm giờ trên mạng thật bị rớt.
- **Soak 60 phút**: dài nhất đã chạy là 45 s cho stream nguồn.
- **Ảnh hưởng tới chat/terminal** khi chạy song song.
- **Windows / macOS**: chưa chạy dòng nào. `h264_qsv`/`h264_vaapi` là đường Linux; `h264_amf` chưa
  từng được chọn ở đây.
- **Trình duyệt di động thật**: `VideoDecoder` trên Chromium di động đã từng chết sau ~1 GOP ở
  Remote Desktop; hook decoder tự hồi phục, nhưng chưa thử với luồng này.
- **Nhiều AVD cùng lúc**: `max_concurrent` mặc định là 1 và chưa nâng lên để thử.

## 7. Tái lập

```bash
# 1. AVD thử nghiệm riêng, không đụng Pixel_9 / Pixel_Tablet của người dùng
bash spikes/android/boot-test-avd.sh &

# 2. E2E mức dịch vụ
ANDROID_EMULATOR_ENABLED=1 PPM_HOME=$(mktemp -d) bun tests/e2e/android-e2e.ts

# 3. E2E qua server thật
ANDROID_EMULATOR_ENABLED=1 bun src/server/index.ts __serve__ 8099 127.0.0.1 dev &
PPM_BASE=http://127.0.0.1:8099 PPM_TOKEN=<token của ppm.dev.db> \
  PPM_HOME=$(mktemp -d) bun tests/e2e/android-ws-e2e.ts
```
