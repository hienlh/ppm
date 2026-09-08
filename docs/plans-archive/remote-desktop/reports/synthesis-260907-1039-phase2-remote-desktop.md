# Phase-2 research synthesis — Remote Desktop (disconnected/locked capture + input + signing)

**Ngày:** 2026-09-07 · Nguồn: research-260907-1039-virtual-display-driver.md, .../system-service-input-station.md (file thực: ak-engineer-researcher-260907-1042-...), research-260907-1039-code-signing-distribution.md.

## Kết luận feasibility (đã de-risk)

| Mục tiêu | Khả thi V1? | Cách |
|---|---|---|
| Stream+control desktop thường khi **RDP disconnected** (unlocked) | ✅ CÓ, rẻ | Bundle **VirtualDrivers/Virtual-Display-Driver (MIT, đã attestation-signed qua SignPath)** → DXGI DDA chụp virtual display → luôn có framebuffer dù không monitor/không RDP. Fix thẳng bug ACCESS_DENIED hôm nay. Spike validate 1–2 ngày. |
| Input tới đúng desktop (bug e2e SendInput no-op) | ✅ CÓ | `OpenInputDesktop(GENERIC_ALL\|DESKTOP_JOURNALPLAYBACK)` + `SetThreadDesktop` trước SendInput; **re-attach mỗi lần switch desktop** (lock/unlock/UAC). CreateProcessAsUserW lpDesktop chỉ set desktop ban đầu, không theo switch. |
| Stream+control khi **LOCKED** (Win+L / secure desktop) | ❌ KHÔNG (V1) | Không vendor nào (kể cả TeamViewer/AnyDesk) vượt Winlogon secure-desktop rẻ được; virtual display KHÔNG chạm trục này. Giữ overlay "không stream được", mở rộng cho cả lock screen. |
| Ký số để không bị Defender quarantine | ✅ rẻ | **Azure Trusted Signing (~$10/tháng)** ký service+helper exe. VDD đã ký sẵn → **0 chi phí driver**. EV chỉ cần nếu tự build driver (không cần). SmartScreen prompt thoáng qua bất kể cert. |

## Cơ chế đã rõ (từ spike + research)
- Service SYSTEM: `WTSEnumerateSessionsW`+WTSActive → DuplicateTokenEx SYSTEM token → SetTokenInformation(TokenSessionId) → CreateProcessAsUserW(helper, lpDesktop="winsta0\default"). ✅ spike.
- Capture gate theo **window station** (nên chụp chạy với 0 dòng attach); Input gate theo **thread desktop** (nên phải attach journal-playback). 2 cơ chế khác nhau — đây là lý do e2e chụp OK mà click fail.
- Named-pipe SYSTEM↔helper: DACL chỉ SYSTEM + PPM principal (không Everyone), frame len-prefixed (VIDEO_NAL/INPUT_CMD/HEARTBEAT/DESKTOP_SWITCHED), 1 helper active, heartbeat respawn.
- AV/EDR: CreateProcessAsUserW cross-session + SendInput = hình dạng RAT (ATT&CK T1134-adjacent) → sẽ bị flag hành vi tới khi ký (phase-06/Trusted Signing). Giảm thiểu: PE không pack, installer tương tác (không silent), audit log spawn, docs công khai.

## Scope phase-2 đề xuất (sửa lại)
**LÀM:** SYSTEM service + session helper (port spike→native crate) + **input-fix** (journal-playback desktop attach, re-attach on switch) + **bundle VDD** để chụp khi disconnected + ký exe qua Azure Trusted Signing.
**KHÔNG (V1):** lock screen + UAC (secure desktop) — giữ overlay.
**Spike rẻ trước khi cook (đề xuất):** (1) VDD validation: cài VDD, DXGI-duplicate nó khi RDP disconnected → xác nhận ra frame (1–2 ngày). (2) Optional: plain Win+L LogonUI có black-screen dưới DXGI-as-SYSTEM không (TeamViewer "view login screen" gợi ý có thể không) — nếu không, có thể mở rộng value; cần spike riêng, không chặn phase-2.

## Unresolved
1. Win+L LogonUI (khác UAC consent.exe) có thực sự black dưới DXGI-as-SYSTEM? Cần spike riêng trước khi hứa "xem login screen".
2. `WTSRegisterSessionNotification` có fire cho UAC secure-desktop switch không — có thể cần poll `OpenInputDesktop`.
3. Azure Trusted Signing eligibility cho publishing identity của PPM chưa xác nhận; CI signing chưa benchmark với scripts/release.sh.
4. VDD bundling: cài driver cần admin 1 lần — xung đột mô hình npm no-installer của PPM (cần bước cài tương tác).
