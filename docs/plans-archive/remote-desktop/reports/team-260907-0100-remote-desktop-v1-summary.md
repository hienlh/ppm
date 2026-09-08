# Team run — Remote Desktop in PPM (V1): plan → red-team → validate → cook → test → review → live screenshot

**Ngày:** 2026-09-07 · **Branch:** `feat/remote-desktop-slice` (33 files, +2207/−16) · **Lead:** main session, 7 agent chuyên trách.

## Pipeline & kết quả

| Phase | Agent | Kết quả |
|---|---|---|
| Plan | planner | `plans/260907-0100-remote-desktop-v1/` — plan.md + 8 phase files (đa-OS, Windows first). |
| Red-team | kongming | `reports/redteam-260907-0100-*.md` — C1 teardown, C2/C3 AU framing+WebCodecs, C4 auth-theater, H1 backpressure, H2/H3 teardown+coords. |
| Validate | Explore | `reports/validation-260907-0100-*.md` — 13/13 anchor khớp code thật (1 lệch dòng nhỏ). |
| Cook | fullstack | Slice 1a (video) + 1b (input) trên branch; 9 test file mới; typecheck sạch (Docker). Mọi must-fix red-team áp vào. |
| Review | code-reviewer | `reports/review-260907-0100-*.md` — R1 (sliced-threads phá AU) BLOCKING; R2 held-keys; R3/R4 minor. |
| Test | tester | 9 test file coverage low-level tốt; gap: session/capture/input chưa test. |
| Live E2E | fullstack | `reports/e2e-260907-0100-*.md` — **FRAME THẬT render trong PPM** (mean 33.34, var 2170, 1148×720). Harness `tests/e2e/remote-desktop-e2e.mjs`. |

## Bằng chứng (screenshot)
- `plans/reports/screenshots/remote-desktop-02-live-frame.png` — **desktop host live trong window Remote Desktop của PPM** (PowerShell history thật, Explorer, taskbar clock; ảnh +1s thấy CPU/MEM nhảy → live). Đã lead verify mắt thường.
- `-01-initial-window.png` (Connecting…), `-03-after-input.png` (stream +1s).

## Chạy được / chưa
- ✅ **1a video-only end-to-end**: gdigrab → H264 (1 slice/frame) → WS (`/ws/remote-desktop`) → WebCodecs → canvas trong floating window PPM. Đây là giá trị chính V1.
- ❌ **1b input**: SendInput báo success nhưng cursor host không di chuyển — process tree (harness headless) không gắn interactive input desktop/window station. Môi trường, không phải bug code. Để phase-02/03 (SYSTEM service gắn đúng session/station).
- ⚠️ **Cần phiên Active**: gdigrab trả ACCESS_DENIED khi RDP session `Disc`. Chụp cần phiên connected. Disconnected/lock cần virtual-display hoặc service path (giống tường UAC ở spike).

## Bug fix live (commit 0c4c1a66 + chuỗi feat)
R1 sliced-threads=0; R2 releaseHeldKeys mọi phím; capture dùng `stopped` flag thay `proc.killed`; forward capture-crash reason ra client; VITE_DEV_API_PORT override; same-origin nới về hostname-only (dev 2-process).

## Docs impact
Docs impact: **minor** — Action: cần thêm mục "Remote Desktop" vào README "What You Get" + `docs/system-architecture.md` khi merge V1 (chưa làm, feature flag OFF, chưa merge).

## Bảo mật (nhắc trước khi bật thật)
- Feature flag mặc định OFF; WS từ chối khi auth tắt; nonce single-use. Nhưng token PPM vẫn là static + đi qua `?token=` (log tunnel) → **KHÔNG bật trên tunnel public** trước phase-07 (host-approval/presence).
- same-origin nới về hostname-only: revisit ở phase-07.

## Unresolved / follow-up
1. `src/services/named-tunnel/...` (named-tunnel.ts) có vẻ dính **cùng bug same-origin host:port** e2e agent gặp — chưa đụng (ngoài scope). Cần verify + fix riêng.
2. 1b input trên interactive station: cần phiên Active + process gắn đúng station; giải quyết trong phase-02 (SYSTEM service) — dùng DXGI (không phải gdigrab) để bền hơn khi switch desktop.
3. Test gap: viết `remote-desktop-session.test.ts` + `remote-desktop-capture.test.ts` (backpressure, getReader teardown, auth-off).
4. "Điều khiển khi disconnected/lock": vướng cả capture (gdigrab ACCESS_DENIED) — cần virtual display driver hoặc DXGI+service; đánh giá lại giá trị vs công sức.
