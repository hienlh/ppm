# Phase 3 report — Cài APK, chụp màn hình, logcat

Ngày: 2026-09-21. Tiếp sau `android-emulator-phase2-report-260921.md`.
Bản này ghi **những gì đo được**, trong đó có một RPC mà proto mô tả đầy đủ nhưng emulator
**không cài đặt** và hỏng theo kiểu im lặng, cùng một chỗ chính tôi viết comment ngược với code.

## 1. Kết quả

| | |
|---|---|
| E2E mức dịch vụ (`tests/e2e/android-phase3-e2e.ts`) | **35/35** |
| E2E qua server thật (`tests/e2e/android-ws-e2e.ts`) | **35/35** (17 check mới của Phase 3) |
| E2E hai máy (`tests/e2e/android-two-device-install-e2e.ts`) | **9/9** |
| Unit mới | **48** (logcat parse 8, apk 16, log filter 18, screenshot download 6) — cộng dồn **116** test Android trên 13 file |
| `tsc --noEmit` | 0 lỗi |
| `bun run build:web` | chunk `android-tab-*.js` 37.17 kB (gzip 11.16) — vẫn lazy, không ai trả giá nếu không mở tab |

Số đo có ý nghĩa:

| | |
|---|---|
| Upload + install thật qua HTTP | **78.75 MB**, upload → operation → `succeeded`, staging sạch sau đó |
| Screenshot PNG | 1.87–1.94 MB, 1080×2400, emulator tự encode |
| Logcat qua WS | 14 batch / 82 entry trong ~4 s, cửa sổ gộp 120 ms |
| `getScreenshot` khi stream video đang chạy | 90 → 164 source frame, **không làm gián đoạn** |

## 2. `sort: Parsed` không tồn tại, và nó hỏng bằng cách im lặng

`emulator_controller.proto` có `LogMessage.LogType.Parsed`, trả về `LogcatEntry` đã tách sẵn
level, tag, pid, tid — đúng thứ panel cần. Đo trên **emulator 36.5.10.0**:

| Yêu cầu | Kết quả trong 8 giây |
|---|---|
| `streamLogcat({sort: "Parsed"})` | **334 message**, `entries` rỗng **và** `contents` rỗng, mỗi reply echo `sort: Text` |
| `streamLogcat({sort: 1})` (enum số) | 57 message, cũng rỗng hoàn toàn |
| `streamLogcat({})` (mặc định `Text`) | 41 message, **18 083 ký tự log thật** |
| `getLogcat` (unary, đã deprecated) | **`12 UNIMPLEMENTED`** |

Điểm đáng ghi không phải "Parsed hỏng" mà là **cách nó hỏng**: không lỗi, không `UNIMPLEMENTED`,
chỉ là một stream bận rộn chở không có gì. Nhìn từ UI nó giống hệt một máy không log. Nếu tin
theo proto thì panel logcat sẽ trống vĩnh viễn trên mọi máy và không có chỗ nào để bắt đầu tìm.

Hệ quả thiết kế: `android-logcat.ts` xin `Text` và **tự parse**. Hai chi tiết nữa đo được, và
chúng quyết định hình dạng parser:

* Mỗi message gRPC mang **đúng một dòng**, **không có `\n` cuối** — nên không cần buffer dòng dở.
  (Vẫn `split("\n")` phòng bản emulator sau gộp dòng, vì nếu gộp mà không split thì nhiều dòng
  sẽ dính thành một entry, lại là một lỗi im lặng nữa.)
* Định dạng là `threadtime` của logcat: `MM-DD HH:MM:SS.mmm PID TID L TAG: message` — **không có
  năm**. Parser lấy năm hiện tại, và lùi một năm nếu như thế đẩy dòng log ra tương lai quá một
  ngày (đọc log tháng 12 vào ngày 1 tháng 1).

Dòng không parse được thì **giữ nguyên**, không bỏ: đó là dòng nối của stack trace hoặc banner
`--------- beginning of main`, mất dòng nào cũng là cắt đôi một crash.

### 2.1 Lệch so với plan, có chủ ý

Plan §4 viết "ADB dùng discovery/boot readiness, cài APK và logcat". Logcat ở đây đi qua **gRPC
`streamLogcat`**, không phải `adb logcat`. Lý do:

* gRPC dùng lại đúng channel đã xác thực của session — không thêm một tiến trình con mỗi máy.
* `adb logcat` cần adb serial, mà serial là `null` trong lúc máy còn boot; channel gRPC thì đã có.
* Theo chính comment trong proto, `streamLogcat` **chạy `logcat` trong guest qua `AdbShellStream`**
  — tức dữ liệu là một, chỉ khác đường vận chuyển.

Cái mất: không đẩy được filter xuống thiết bị (`adb logcat -s TAG:E`), nên mọi dòng đều qua dây
rồi mới lọc ở client. Đo thực tế ~40 message/8 s nên chưa đáng đổi. Cài APK thì **vẫn đi adb**
đúng như plan, vì `EmulatorController` không có RPC install nào cả.

## 3. `adb install` không chọn bừa — nó từ chối

Comment đầu tiên tôi viết trong `android-apk.ts` nói `adb install` không `-s` sẽ "chọn máy nào
tuỳ nó thích". Đo với hai emulator đang chạy:

```
$ adb install <file>
adb: more than one device/emulator
```

Nó **từ chối, không cài gì cả**. Sửa lại comment. Điều này làm `-s` còn quan trọng hơn: trên máy
một emulator thì thiếu `-s` vẫn chạy **nhờ may**, và hỏng đúng vào ngày người dùng mở máy thứ hai.

Gate "install đúng target khi có hai máy" được chứng minh bằng
`tests/e2e/android-two-device-install-e2e.ts`, 9/9. Chỗ khó là **làm cho test có thể fail**: hai
AVD spike dùng chung một system image nên danh sách package giống hệt nhau, và cài một gói cả
hai đều có sẵn thì pass dù `-s` có được tôn trọng hay không. Test tự tạo chênh lệch bằng
`pm uninstall --user 0 com.google.android.deskclock` trên máy đích (`--user 0` vì đây là app hệ
thống, uninstall thường bị từ chối), rồi kiểm tra cả hai máy trước và sau, và trả lại nguyên trạng.

## 4. Huỷ upload không để lại temp

Gate của plan. Không tự nhiên mà có: request bị abort làm phép đọc **fail giữa chừng file**, nên
phần đã ghi phải bị xoá trên mọi nhánh lỗi.

`stageApkUpload` xoá file dở khi abort, khi quá hạn mức, và khi header không phải zip — kiểm tra
4 byte đầu **trong lúc** stream, nên một body 5 GB bị cắt tại ngưỡng chứ không phải sau khi đã
ghi xong. PPM bị kill giữa chừng upload thì `sweepApkStaging()` dọn ở lần sau (quá 1 giờ).

Đo qua server thật: abort giữa upload → `AbortError`, thư mục staging **0 file**; upload 78.75 MB
thành công → install `succeeded` → staging lại **0 file**.

## 5. Giết tiến trình **không** làm đóng pipe của nó

Deadline cho `adb install` (plan §7 yêu cầu) tưởng là một dòng `setTimeout(() => proc.kill())`.
Test bằng một `adb` giả là script `#!/bin/sh\nsleep 30`: kill xong, `reader.read()` **vẫn không
bao giờ resolve** — `sh` chết nhưng `sleep` con thừa kế pipe và giữ nó mở. Test timeout 5 s.

Tức là bản đầu tiên của tôi có deadline nhưng deadline không thoát được: hàm vẫn treo đúng chỗ nó
định cứu. Sửa bằng cùng hình dạng `Encoder.stop()` trong `android-video.ts` đã phải dùng cho
ffmpeg — **race**, không chờ:

```ts
const outcome = await Promise.race([collected, expired, aborted]);
```

`cancelled` cũng phải nằm trong race vì cùng một lý do: một cancel chờ read kết thúc sẽ treo tới
tận deadline 10 phút thay vì trả lời ngay. Hai unit test giữ cả hai nhánh, và cả hai đều **đo thời
gian** chứ không chỉ đo kết quả — một bản sửa sai vẫn trả đúng message, chỉ là sau 10 phút.

## 6. `DeviceEntry.state` không bao giờ báo `booting`

Plan §6 nói "install APK chỉ khi guest ready". Cách hiển nhiên là `if (device.state !== "ready")`.
Nhưng `listDevices` là hàm **đồng bộ** và đặt `state: e ? "ready" : "stopped"` — tức mọi máy có
tiến trình đều là `ready`, và giá trị `"booting"` khai báo ở dòng 27 của `device-registry.ts`
chưa từng được sinh ra. Check đó là một tautology.

Câu trả lời thật là `getStatus().booted` của chính emulator, tốn một RPC trước mỗi lần install.
Đây là lỗ hổng của Phase 1, không sửa ở Phase 3 vì làm `listDevices` thành async sẽ chạm mọi
caller; ghi lại ở đây để Phase 4 xử lý khi làm device manager.

## 7. Chỗ tôi viết comment ngược với code, và e2e bắt được

`case "logcat"` trong `android-session.ts` nằm **dưới** cổng kiểm tra lease, trong khi comment
ngay trên nó viết "Not gated on the controller lease". Tức là viewer không giữ lease — đúng
người cần đọc log khi người khác đang điều khiển — bị từ chối im lặng.

Không unit test nào bắt được: nó chỉ sai khi có **hai** viewer và lease đã chuyển. `android-ws-e2e.ts`
gửi `logcat` từ viewer A **sau khi** B đã cướp lease, và trả về `0 batches, 0 entries`. Đây là lý
do e2e hai-viewer đáng viết chứ không phải là thừa.

## 8. Quyết định thiết kế

* **Ring buffer sống qua lần đóng panel.** Gate nói "logs hidden ngừng subscription" — stream gRPC
  dừng thật. Nhưng vứt luôn backlog là chuyện khác và tệ hơn: đóng panel để đọc stack trace ở chỗ
  khác rồi mở lại sẽ thấy hộp rỗng. Ring (2000 entry) chỉ mất khi session của máy đóng. Giá phải
  trả: khoảng trống trong log ở quãng không ai xem — timestamp nói rõ điều đó.
* **Batch log 120 ms.** Một WS frame mỗi message gRPC sẽ vừa ngập socket vừa tranh chỗ với video
  trên cùng một dây. Viewer nào đang tắc socket thì bỏ qua batch — ring ở server giữ lại rồi.
* **Screenshot là PNG, không phải RGBA thô.** Emulator tự encode, nên không chỗ nào ở đây phải
  biết layout buffer — mà đó đúng là chỗ proto nói sai (Phase 2 §2.1: proto ghi "bottom up",
  đo ra top-down). File người dùng tải về không phải chỗ để phát hiện lại chuyện đó.
* **Panel công cụ nằm **dưới** màn hình ở mọi kích thước.** Không phải nhượng bộ cho mobile: log
  phải đọc được *đồng thời* với việc chạm vào guest, mà modal thì không — và dưới cùng cũng là
  thumb zone mà design guidelines yêu cầu, nên layout điện thoại ra từ cùng một quyết định.
* **Không panel nào được mount khi tab của nó đóng**, nên subscription logcat bám theo panel:
  chuyển sang tab Install là dừng stream log thật sự.
* **Cài từ project nhận `{project, path}`, không nhận đường dẫn tuyệt đối.** Nhận tuyệt đối thì
  route này thành trình đọc file tuỳ ý. Path được resolve *bên trong* project rồi từ chối nếu
  thoát ra (400) — cùng luật `extension-rpc-handlers.ts` đang dùng.
* **Quét APK trong project bị giới hạn**: sâu tối đa 8 cấp, prune `node_modules`/`.git`/`.gradle`…
  Cùng lý do với lệnh cấm `fs.watch` đệ quy trong CLAUDE.md.
* **Hai hạn mức, không phải một.** `MAX_APK_BYTES` (2 GB) chặn một file vô lý; `MAX_STAGING_BYTES`
  (4 GB) chặn nhiều file hợp lệ cùng lúc. Thiếu cái thứ hai thì hai upload 2 GB song song đều hợp
  lệ theo hạn mức riêng và cùng nhau làm đầy đĩa mà database đang nằm trên đó.

## 9. Không log nội dung input/clipboard

Gate cuối. Kiểm tra bằng hai cách: `grep` mọi `console.*` trong `src/services/android/`,
`src/server/ws/android.ts`, `src/server/routes/android.ts` — ba chỗ duy nhất đều là thông báo lỗi
(`could not persist ownership`, `logcat stream … failed`, `failed to start a session`), không chỗ
nào chạm vào `text`/`entries`. Và grep chuỗi bí mật của e2e clipboard trong log server sau khi
chạy: **0 lần xuất hiện**.

## 10. Chưa đo — không được coi là đã đạt

* Split APK (`install-multiple`). Plan cho phép bỏ qua nếu chưa có workflow rõ ràng; hiện **không
  hỗ trợ**, và một file `.apks`/`.aab` sẽ bị adb từ chối với `INSTALL_FAILED_INVALID_APK` — thông
  báo có giải thích, nhưng vẫn là từ chối.
* Cài APK **lỗi ABI / minSdk / chữ ký thật**. Bảng `FAILURES` được unit test bằng output adb dựng
  sẵn, chưa chạy với APK thật gây ra từng lỗi đó (cần APK arm-only và APK ký khác — chưa có).
* Upload qua tunnel Cloudflare (timeout idle của proxy với body 78 MB).
* Logcat trên máy **nói nhiều** (app đang crash-loop): mới đo ~40 msg/8 s trên máy nhàn rỗi.
* Panel trên trình duyệt mobile thật.

## 11. Tái lập

```bash
# 1. AVD thử nghiệm riêng, không đụng Pixel_9 / Pixel_Tablet của người dùng
bash spikes/android/boot-test-avd.sh &
AVD=ppm_spike_test2 LOG=/tmp/ppm-android-spike/emulator2.log bash spikes/android/boot-test-avd.sh &

# 2. E2E mức dịch vụ
ANDROID_EMULATOR_ENABLED=1 PPM_HOME=$(mktemp -d) bun tests/e2e/android-phase3-e2e.ts

# 3. Gate hai máy
ANDROID_EMULATOR_ENABLED=1 PPM_HOME=$(mktemp -d) bun tests/e2e/android-two-device-install-e2e.ts

# 4. E2E qua server thật (PPM_SERVER_HOME để check staging đúng PPM_HOME của server)
SRV=$(mktemp -d)
ANDROID_EMULATOR_ENABLED=1 PPM_HOME=$SRV bun src/server/index.ts __serve__ 8099 127.0.0.1 &
PPM_SERVER_HOME=$SRV PPM_BASE=http://127.0.0.1:8099 PPM_TOKEN=<token> \
  PPM_HOME=$(mktemp -d) bun tests/e2e/android-ws-e2e.ts
```
