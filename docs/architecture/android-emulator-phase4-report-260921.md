# Phase 4 report — Tạo, wipe, xoá AVD ngay trong PPM

Ngày: 2026-09-21. Tiếp sau `android-emulator-phase3-report-260921.md`.

Bản này ghi **những gì đo được**. Trong Phase 4 có ba lỗi đáng kể, và cả ba đều **im lặng**:
một lỗi ghi AVD vào thư mục AVD **thật của người dùng**, một lỗi khiến mọi emulator đang chạy
đều bị báo là "không ai khoá", và một lỗi của chính bài test chứ không phải của sản phẩm.

## 1. Kết quả

| | |
|---|---|
| E2E gate Phase 4 (`tests/e2e/android-avd-crud-e2e.ts`) | **34/34** — tạo → boot → ghi dữ liệu → stop → boot lại → wipe → boot lại → xoá |
| E2E qua server thật (`tests/e2e/android-ws-e2e.ts`) | **48/48** — 34 check cũ + **14 check mới** cho route Phase 4 |
| Unit mới | **34** (avd-manager 20, system-images 13, lock NUL 1) — cộng dồn **143** test Android trên 15 file |
| `tsc --noEmit` | 0 lỗi |
| `bun run build:web` | chunk `android-tab-*.js` **48.35 kB** (gzip 14.08) — tăng ~11 kB so với Phase 3, vẫn lazy |
| Toàn bộ `bun test` | 7146 pass / 33 fail — **không có test Android nào đỏ**; 33 lỗi nằm trong các nhóm đã biết từ trước (codex 18, tunnel 7, cloud-ws 2, 6 lỗi lẻ), số lượng dao động giữa các lần chạy ở nhóm tunnel |

Số đo có ý nghĩa:

- `avdmanager list device` mất **~730 ms** lần đầu và **0 ms** sau đó (cache trong tiến trình);
  88 profile, trong đó 39 phone và 13 tablet.
- Đọc system image từ **đĩa** thay vì `sdkmanager --list_installed`: tức thì, không có thanh
  tiến trình phải bóc tách, và vẫn trả lời đúng trên máy có image nhưng **không có** cmdline-tools.
- AVD tạo bởi PPM: boot lần đầu **25 s**, boot lại từ snapshot **3 s**, boot sau wipe **24 s**.
- Một wipe giải phóng **3.2 GB** trên AVD đã boot hai lần.

## 2. `ANDROID_AVD_HOME` trỏ vào thư mục **không tồn tại** thì avdmanager ghi vào `~/.android/avd`

Đây là biến thể thứ hai của cùng một cái bẫy, và nó nguy hiểm hơn cái đầu.

- Lần đầu (đã ghi ở Phase 4 khi đang code): **không** set `ANDROID_AVD_HOME` cho tiến trình con
  thì `avdmanager` ghi AVD vào `~/.android/avd` — đúng thư mục AVD thật của người dùng. Sửa bằng
  `avdHomeEnv()` trong `sdk-discovery.ts`, dùng chung với `emulator-launcher.ts`.
- Lần hai: **có** set `ANDROID_AVD_HOME`, nhưng trỏ vào thư mục vừa bị xoá. `avdmanager` **không
  báo lỗi** — nó lặng lẽ quay về `~/.android/avd` và ghi AVD ở đó. Phát hiện bằng
  `find ~ -maxdepth 4 -name 'ppm_wipe_probe*'`.

Cả hai lần đều không đụng `Pixel_9` / `Pixel_Tablet`; AVD lạc đã được xoá tay ngay.

Sửa: một dòng `mkdirSync(opts.avdHome, { recursive: true })` trước khi chạy tool. Kiểm tra
"config.ini có xuất hiện đúng chỗ không" ở cuối `createAvd` vẫn giữ nguyên — nó chính là thứ đã
**bắt được** cả hai lần, nên nó không phải kiểm tra thừa.

Bài học chung: một biến môi trường kiểu "thay thế đường dẫn" cần thư mục **có thật**; nếu không,
tool sẽ dùng mặc định và trông như đang hoạt động bình thường.

## 3. File lock của emulator kết thúc bằng NUL, nên `trim()` không cứu được

`hardware-qemu.ini.lock` của một emulator đang chạy, đọc bằng `xxd`:

```
00000000: 3531 3937 3732 00                        519772.
```

7 byte: `519772` rồi **một byte NUL**. `String.prototype.trim()` chỉ bỏ khoảng trắng, mà NUL
không phải khoảng trắng — nên `Number("519772\0")` là `NaN`, `Number.isInteger(NaN)` là `false`,
và `isLocked()` trả `false` cho **mọi** emulator đang chạy.

Hậu quả, tất cả đều im lặng:

- Dòng cảnh báo "Locked by another process — it is probably open in Android Studio" trong danh
  sách thiết bị **chưa từng hiện**.
- `assertDestructible()` của Phase 4 có một lớp bảo vệ không hoạt động (lớp "đang chạy" vẫn
  hoạt động, vì nó quét tiến trình chứ không đọc lock).

Lý do nó sống sót qua Phase 1: unit test tự viết fixture `` `${process.pid} ` `` — pid kèm một
**dấu cách**. `trim()` xử lý được dấu cách, nên bài test xanh với đúng giả định sai của người
viết nó. Bài test mới ghi đúng thứ emulator ghi (`${pid}\0`) và đỏ trước khi sửa.

Sửa: lấy cụm số ở đầu file (`/^\s*(\d+)/`) thay vì tin vào `trim()`.

Kiểm tra lại trên máy thật, có một emulator đang chạy:

```
ppm_spike_test         locked=true      ← đang chạy
ppm_spike_test2        locked=false
Pixel_9                locked=false
Pixel_Tablet           locked=false
```

## 4. `userdata.img` **không** được xoá khi wipe — tài liệu của chính emulator nói vậy

Danh sách wipe ban đầu có `userdata.img`. `emulator -help-disk-images` xếp nó vào nhóm ảnh
**khởi tạo**, cùng chỗ với `system.img`, và định nghĩa wipe là:

> `-wipe-data`  Copy the content of the *initial* user data image (userdata.img) into the
> writable one (userdata-qemu.img)

Tức là xoá `userdata.img` chính là xoá bản gốc mà một lần wipe cần để khôi phục.

Đo thêm cho đủ: AVD tạo bằng tooling hiện tại trên máy này **không có** `userdata.img` trong thư
mục AVD (nó nằm trong thư mục system image), nên lỗi này không biểu hiện ở đây — boot sau wipe
vẫn 24 s. Nó chỉ cắn một AVD do tooling cũ tạo ra, im lặng, ở lần boot kế tiếp. Đúng loại việc
mà danh sách cho phép (allowlist) sinh ra để tránh.

## 5. Ba lỗi của **bài test**, không phải của sản phẩm

1. **`adb shell sh -c "echo X > file"`** — `adb` nối các tham số bằng dấu cách rồi đưa cả chuỗi
   cho shell **của máy ảo**, nên dấu `>` bị shell đó nuốt: `sh -c echo` chạy với `echo` là lệnh và
   ghi một dòng trống. File có thật, nội dung rỗng, và hai check "ghi được file" + "dữ liệu còn
   sau khi stop" cùng đỏ. Sửa: truyền **một** tham số duy nhất.
2. **`boot()` nuốt output của emulator** — một lần boot không xong chỉ báo đúng chữ `no`, tức là
   thứ duy nhất đáng quan tâm thì không có. Giờ mỗi lần boot ghi ra một file log và phần tổng kết
   in đường dẫn của những lần boot hỏng.
3. **Một lần "boot sau wipe" hỏng không tái lập được** — chạy lại đúng kịch bản đó bằng một
   probe riêng (tạo → boot → ghi → stop → wipe → boot) thì boot lần hai mất 24 s và thành công;
   lần chạy e2e kế tiếp cũng qua. Ghi lại ở đây thay vì tuyên bố là đã hiểu: nó **chưa được giải
   thích**, chỉ là không lặp lại.

## 6. Quyết định thiết kế

- **PPM không tải system image.** `/system-images` đọc cây `system-images/<api>/<tag>/<abi>/
  source.properties` trên đĩa. Không có nút tải, không tự chấp nhận licence — đúng plan Phase 4.
  Image sai CPU vẫn được **liệt kê** nhưng không chọn được, kèm lý do ngay trên dòng đó: ẩn đi thì
  người dùng biết mình đã cài mà không thấy, và sẽ nghĩ là lỗi.
- **Bắt buộc có device profile.** `avdmanager create avd` không `--device` cho ra AVD **320x640**
  (đã đo ở Phase 4 khi code), trông như emulator hỏng chứ không như thiếu tham số.
- **`hw.keyboard=yes` luôn được ghi** sau khi tạo. `avdmanager` ghi `no`; với `no` thì `sendKey`
  trả OK và không một ký tự nào tới máy ảo (đo ở Phase 0).
- **Không `--force`.** Trùng tên bị từ chối, vì ghi đè một AVD là hành vi phá huỷ đội lốt tạo mới.
- **Tên được kiểm tra, không được escape.** Regex nằm ở `src/shared/android-avd.ts` và **dùng
  chung** cho form lẫn host — hai bản sao của một regex kiểm tra là hai bản sẽ lệch nhau, và cách
  chúng lệch là form nhận một cái tên rồi host từ chối sau khi hộp thoại đã đóng.
- **Wipe là allowlist chứ không phải glob.** File nào code này chưa biết thì **giữ lại**.
- **Wipe/Delete: gõ lại đúng tên máy.** Không phải checkbox — các dòng trong danh sách nhìn giống
  hệt nhau, và checkbox chỉ xác nhận rằng có một hộp thoại đang mở, không xác nhận nó mở trên máy nào.
- **Nút ba chấm nhìn thấy được**, không phải right-click hay long-press: wipe và delete không có
  đường nào khác, mà một cử chỉ ẩn thì không phải là một đường đi. Nó là control riêng nên không
  cướp mất cú chạm của cả dòng (bẫy đã ghi trong CLAUDE.md).

## 7. UI đo trên trình duyệt thật, không chỉ đọc code

Chạy PPM đã build (`bun run build:web` rồi serve `dist/web`) và lái bằng Playwright, ở **390x844**:

| | |
|---|---|
| Hộp thoại tạo máy dưới `md` | là **bottom sheet** thật (đáy dính đáy màn hình) |
| Tràn ngang | **không** (`scrollWidth === innerWidth`) |
| Vùng chạm | 7/7 control **44 px** — nhưng chỉ sau khi sửa: trigger của `SearchSelect` mặc định là `h-10 md:h-7`, tức **40 px**, dưới ngưỡng. Đo mới thấy, đọc code thì không. |
| Nút ba chấm mỗi dòng | 44x44 |
| Mục menu | "Wipe data" 44 px, "Delete device" 44 px và `data-variant="destructive"` |
| Sheet xác nhận | nút vẫn **disabled** khi gõ tên sai (`Pixel_9_wrong`) và khi thiếu **một ký tự** (`ppm_ui_prob`) |

Và chạy trọn vòng **qua chính UI** với server thật: tạo `ppm_ui_probe` → nó hiện trong danh sách
(API 37, 1080x2424, **không** có cảnh báo thiếu hardware keyboard, tức `hw.keyboard=yes` đã vào)
→ xoá bằng cách gõ đúng tên → biến mất. `Pixel_9` (26 file) và `Pixel_Tablet` (22 file) nguyên vẹn.

Một quan sát phụ, tình cờ: `vite build` xoá `dist/web` nên tab đang mở mất chunk — và màn hình
khôi phục chunk (`root-error-boundary` + watchdog) đã bắt đúng, hiện nút Reload thay vì trắng trang.

## 8. Cách viết test phá huỷ mà không phá gì

Trong `android-ws-e2e.ts` (chạy với AVD **thật** của người dùng) có check "không wipe được máy
đang chạy". Nó gửi kèm `confirmName` **sai**:

```ts
{ confirmName: "definitely-not-its-name" }
```

rồi mới khẳng định thông báo lỗi nói về *đang chạy*. Nghĩa là phải **hai** lớp bảo vệ cùng hỏng
mới mất dữ liệu. Một bài test có thể phá dữ liệu người dùng khi code hỏng thì không đáng viết.

Còn gate thật của Phase 4 (tạo/wipe/xoá thật) nằm ở `android-avd-crud-e2e.ts`, chạy trong AVD
home riêng `~/.android-phase4-avd` và tự dọn — không đụng `Pixel_9` / `Pixel_Tablet` (plan §9).

## 9. Chưa đo — không được coi là đã đạt

- Chưa thử trên Windows / macOS: `avdmanager` là `.bat` trên Windows và cách nó nhận stdin `no\n`
  chưa được kiểm tra ở đó.
- Chưa thử với AVD do **Android Studio** đang mở (lock thật của Studio, chứ không phải của
  emulator do PPM khởi động) — giờ mới có `isLocked` đúng để thử.
- Chưa thử tạo AVD khi ổ đĩa đầy, và chưa thử `sdCardMb: 0` trên máy thật.
- Chưa đo p50/p95 click-to-visible trên LAN và qua tunnel (vẫn là mục còn nợ từ §10 của plan).

## 10. Tái lập

```bash
# Gate Phase 4 — mất vài phút, 4 lần boot, AVD home riêng
ANDROID_EMULATOR_ENABLED=1 PPM_E2E_LOG_DIR=/tmp/p4logs PPM_HOME=$(mktemp -d) \
  bun tests/e2e/android-avd-crud-e2e.ts

# Route Phase 4 qua server thật
ANDROID_EMULATOR_ENABLED=1 bun src/server/index.ts __serve__ 8099 127.0.0.1 dev
PPM_BASE=http://127.0.0.1:8099 PPM_TOKEN=<token> PPM_HOME=$(mktemp -d) \
  bun tests/e2e/android-ws-e2e.ts

# Unit
bun test tests/unit/android tests/unit/web/android-*.test.ts
```
