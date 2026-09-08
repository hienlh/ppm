# Research: Giảm lag cho Remote Desktop trong PPM

**Ngày:** 2026-09-07 13:14 · **Bối cảnh:** slice hiện tại — ffmpeg gdigrab → **libx264** (software) 15fps GOP 2s → WS qua **cloudflared quick tunnel** → WebCodecs → canvas. Máy host có **RTX 4070 (NVENC)**.

## Lag đến từ đâu (xếp theo mức đóng góp)

| Nguồn | Ước lượng | Ghi chú |
|---|---|---|
| **cloudflared quick tunnel (public relay)** | **~200–260ms** | Gói chạy vòng qua edge Cloudflare rồi quay lại; report cộng đồng đo +260ms vs direct. Quick tunnel còn cap 200 in-flight, WS nhạy origin-timeout. **Phần lớn lag nằm ở đây.** |
| **Encode software (libx264)** | ~30–100ms | GPU encode (NVENC) chỉ ~5–15ms. Chênh 20–85ms/khung. |
| **Framerate 15fps** | ~66ms/khung | Cảm giác giật; 30–60fps mượt hơn. |
| **GOP 2s + drop-to-keyframe** | tới 2s khi nghẽn | Mỗi lần backpressure/loss chờ keyframe kế. |
| WebCodecs decode + canvas | thấp | Giải mã ngay — giữ. |
| Input path | đã giảm | Throttle move theo rAF (vừa fix). |

## Khuyến nghị (tác động cao → thấp)

### Tier 1 — Transport (thắng lớn nhất, ~200ms)
- **Dùng LAN/direct khi cùng mạng:** kết nối thẳng tới PPM (IP:port nội bộ), KHÔNG qua cloudflared → xoá ~200–260ms relay. Cú hích lớn nhất cho dùng tại nhà/office.
- **Remote qua internet:** quick tunnel là tệ nhất. Chọn: (a) named tunnel + Argo (giảm chút), (b) WebRTC P2P + STUN đục lỗ đi thẳng, fallback WS — nhưng WebRTC cần UDP (Cloudflare HTTP/WS không tải media; cần TURN riêng) → hạng mục kiến trúc lớn, cân nhắc riêng. WS-over-relay latency thực ra thấp hơn WebRTC-qua-relay; WebRTC chỉ thắng khi P2P thật.
- cloudflared `--protocol quic`/`h2mux` chỉ cải thiện biên.

### Tier 2 — Encoder NVENC (thắng ~30–85ms, dễ làm)
- Đổi `remote-desktop-encoder-args.ts` từ ép libx264 → **h264_nvenc khi có** (đã detect NVENC trong `ffmpeg-capabilities.ts`; máy có RTX 4070). Cờ: `-preset p1..p4 -tune ll`(hoặc `ull`)` -rc cbr -zerolatency 1 -delay 0 -bufsize {bitrate/fps}`. Giữ libx264 fallback.
- Lo ngại "profile/level deterministic" khi ép libx264 KHÔNG còn giá trị — codec string đã suy từ SPS runtime (`avc1-codec-string.ts`), NVENC an toàn.

### Tier 3 — Framerate + GOP
- 15fps → **30fps** (cấu hình được). Mượt + giảm lag cảm nhận.
- GOP: giữ ~1s + **force-IDR theo yêu cầu** khi client resync sau backpressure thay vì chờ hết GOP (`-force_key_frames` / signal on-demand).

### Tier 4 — Vi-độ-trễ pipeline
- ffmpeg output: `-flush_packets 1 -fflags nobuffer -max_delay 0 -probesize 32 -analyzeduration 0` để không đệm trước khi phát.
- WebCodecs `configure({ ..., optimizeForLatency: true })`; render `VideoFrame` ngay khi `output`, `close()` liền, không queue.

### Tier 5 — Thích ứng (công lớn hơn)
- Đo RTT/bandwidth → tự chỉnh bitrate/fps/resolution. Overlay timestamp để đo glass-to-glass.

## Đề xuất làm ngay (rẻ, tác động cao)
1. NVENC low-latency (Tier 2) + 30fps (Tier 3) + ffmpeg no-buffer + WebCodecs optimizeForLatency (Tier 4) — đều là code-change nhỏ trong module remote-desktop, không đổi kiến trúc.
2. Tài liệu hoá: local dùng **direct (no tunnel)**; tunnel chỉ cho remote, chấp nhận +200ms.

## Câu hỏi chưa chốt
1. Có làm WebRTC P2P (LAN/hole-punch) làm transport hạng 2 không? Hạng mục lớn (UDP, TURN fallback) — chỉ đáng nếu cần remote-internet mượt.
2. NVENC trên phiên RDP/headless có chạy không (GPU access under session)? Cần test — verify luôn khi làm spike VDD (phase-2).
3. fps/bitrate mặc định + cho user chỉnh trong UI?

## Nguồn
- [Cloudflare Tunnel +260ms vs direct](https://community.cloudflare.com/t/cloudflare-tunnel-added-260ms-vs-direct-connection-even-with-argo-routing/477208) · [Quick Tunnels limits](https://deepwiki.com/cloudflare/cloudflared/3.4-quick-tunnels) · [Cloudflare UDP improvements 2025](https://developers.cloudflare.com/changelog/post/2025-07-15-udp-improvements)
- [NVENC low latency (NVIDIA forums)](https://forums.developer.nvidia.com/t/ffmpeg-and-low-latency-h264-streaming/249906) · [FFmpeg NVENC guide (StreamFX)](https://github.com/Vhonowslend/StreamFX-Public/wiki/Encoder-FFmpeg-NVENC)
- [Moonlight/Sunshine ultra-low-latency](https://joltfly.com/optimize-moonlight-game-streaming-for-ultra-low-latency/) — GPU encode 5–15ms vs SW 30–100ms; 60fps + wired
- [WebCodecs real-time pipelines (webrtcHacks)](https://webrtchacks.com/real-time-video-processing-with-webcodecs-and-streams-processing-pipelines-part-1/) · [WebSocket vs WebRTC latency (Ably)](https://ably.com/topic/webrtc-vs-websocket)
