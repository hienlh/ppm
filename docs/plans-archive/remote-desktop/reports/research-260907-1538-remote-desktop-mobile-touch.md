# Research + Design: Remote Desktop mobile touch→mouse

**Ngày:** 2026-09-07 · Cho phase mobile của remote-desktop (điều khiển host từ điện thoại). Tham chiếu: TeamViewer 2-mode + web canvas gesture patterns.

## Mô hình 2 mode (giống TeamViewer)

| Mode | Ngón tay làm gì | Dùng khi |
|---|---|---|
| **Touch (direct/absolute)** | Chạm đâu = chuột tới + click đó (toạ độ tuyệt đối) | Target to, thao tác nhanh |
| **Mouse (trackpad/relative)** | Rê ngón = di con trỏ tương đối (như touchpad); tap = click tại vị trí con trỏ hiện tại | Cần chính xác (nút nhỏ) |

- Mặc định **Mouse mode** (giống TeamViewer iOS) — chính xác hơn cho desktop UI.
- Toggle Touch/Mouse ngay trên toolbar, đổi được giữa chừng.

## Cử chỉ (chung 2 mode)
- **1 ngón tap** → left click.
- **2 ngón tap** → right click.
- **2 ngón rê** → scroll (cần server hỗ trợ wheel — xem dưới).
- **Pinch 2 ngón** → zoom canvas (client-side transform) để select chuẩn.
- **2 ngón rê khi đang zoom** → pan view.
- Mouse mode: 1 ngón rê = di con trỏ ảo (delta × hệ số nhạy); có con trỏ overlay vẽ trên canvas.
- Touch mode: 1 ngón rê = kéo (drag) từ điểm chạm.

## Kỹ thuật (web canvas)
- `touch-action: none` trên canvas để nhận raw touch (không để browser tự scroll/zoom).
- Zoom/pan = **CSS transform** trên canvas (scale + translate), tách khỏi toạ độ remote. Khi inject: map điểm chạm **qua transform hiện tại** → fraction 0..1 của capture (dùng `getBoundingClientRect` + scale/translate ngược).
- Mouse mode: giữ **con trỏ ảo client-side** (x,y trong không gian capture); rê ngón cộng delta (đã chia scale); tap gửi **absolute click tại con trỏ ảo** → KHÔNG cần server đổi (vẫn absolute injection hiện có).
- Phân biệt tap vs drag: ngưỡng di chuyển (~10px) + thời gian (<300ms) = tap.
- Phân biệt pinch-zoom vs 2-ngón-scroll: nếu khoảng cách 2 ngón đổi >ngưỡng → zoom; nếu cùng dịch → scroll.

## Cần thêm server-side (nhỏ)
- **Wheel/scroll**: input hiện chỉ có move+click+key. Thêm `injectWheel(dz)` (SendInput MOUSEEVENTF_WHEEL) cho 2-ngón-scroll. (Có thể để phase sau nếu muốn tối giản.)
- Relative move: KHÔNG cần (mouse mode dùng con trỏ ảo + absolute).

## UI mobile
- Full-screen host (KHÔNG phải floating window — `WindowLayer` không render dưới `md`). Mount như sheet toàn màn hình (giống os-explorer mobile).
- Toolbar mỏng trên/dưới: [Touch/Mouse toggle] [Keyboard] [Zoom reset] [Đóng]. Đặt ở **vùng thumb** (dưới) theo design-guidelines.
- Nút bàn phím → focus hidden input → forward keydown/up (tái dùng use-remote-input-capture logic key).
- Badge "đang điều khiển" + re-auth vẫn áp dụng.

## Kế hoạch implement (thứ tự)
1. `open-remote-desktop`: mobile → mở full-screen host thay vì window (như openExplorer). Mount điểm mobile.
2. Component `remote-desktop-mobile-view`: canvas + zoom/pan transform + gesture engine (tap/2-tap/pinch/pan/drag) + mode toggle + virtual cursor overlay (mouse mode).
3. Map touch→capture-fraction qua transform; tái dùng WS + decoder hiện có (dùng chung `use-h264-canvas-decoder`).
4. (Optional) server `injectWheel` cho 2-ngón-scroll.
5. Thêm lại nút mobile drawer (đã revert) trỏ vào host mới.
6. Virtual keyboard.

## Unresolved
1. 2-ngón-scroll: làm luôn `injectWheel` hay để sau? (đề xuất làm luôn — scroll rất cần).
2. Long-press = right-click (thay/thêm cho 2-ngón-tap)? TeamViewer dùng cả hai.
3. Có cần cả relative-move server-side cho "mouse mode" thật (thay vì con trỏ ảo client)? Con trỏ ảo đơn giản hơn, đủ tốt V1.

## Nguồn
- [TeamViewer iOS interaction methods](https://community.teamviewer.com/English/kb/articles/109353-interaction-methods-on-ios) · [Android touch vs mouse](https://community.teamviewer.com/English/kb/articles/2846-touch-interactions-vs-mouse-interactions-on-android)
- [RustDesk canvas-zoom vs forward gestures](https://github.com/rustdesk/rustdesk/discussions/12865) · [RustDesk touchpad gestures issue](https://github.com/rustdesk/rustdesk/issues/3744)
- [MDN touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/touch-action) · [Konva multi-touch pinch zoom](https://konvajs.org/docs/sandbox/Multi-touch_Scale_Stage.html) · [pinch-zoom vs 2-finger scroll (ctrlKey wheel)](https://tigerabrodi.blog/how-to-handle-trackpad-pinch-to-zoom-vs-two-finger-scroll-in-javascript-canvas-apps)
