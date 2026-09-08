# Red-team — Remote Desktop V1 (approach B), phase-01 Windows slice

**Date:** 2026-09-07 · **Target:** `plans/260907-0100-remote-desktop-v1/` (focus phase-01) · **Ground truth:** spike `spike-260907-0048-...`
**Verdict:** Slice is *feasible* but the plan under-specifies four things that will each break a naive build: WebCodecs access-unit framing (not raw NAL), the segfault-safe teardown for a WS (not a Response), WS backpressure over the tunnel, and the security model (static-token "re-auth" is theater). Fix those before cook.

Legend severity: CRITICAL = slice won't work / opens host to takeover · HIGH = will bite during build/first run · MED = will bite at scale/edge · LOW = polish.

---

## CRITICAL

### C1 — "Reuse the segfault-safe pattern" targets a Response, not a WebSocket; the natural WS rewrite re-triggers the crash
**Claim (plan):** capture "expose an async iterator of NAL frames" and "reuse the segfault-safe subprocess→stream pattern (`transcode-stream.ts:130-155`)."
**Failure scenario:** `transcode-stream.ts` wraps `proc.stdout.getReader()` into a `ReadableStream` fed to an HTTP `Response`; its safety comes from `cancel(){ kill() }` and *never* calling `reader.cancel()` (verified `transcode-stream.ts:130-155`). For video→WS you don't return a Response — you loop and `ws.send()`. The idiomatic rewrite is `for await (const chunk of proc.stdout) { ws.send(chunk) }`. On WS close you `break`/`return` out of that loop → the async-iterator's `return()` calls `reader.cancel()` on `proc.stdout` → **the exact segfault the memory + guard test warn about** (Bun 1.3.x Windows, client disconnect). An async iterator "of NAL frames" hides the same trap one layer down.
**Evidence:** memory `project_bun-subprocess-stdout-response-segfault`; `transcode-stream.ts:130-155` comment; CLAUDE.md gotcha.
**Mitigation (must-fix):** Spell it out in the phase: manual `getReader()`, pull loop, and teardown = **`proc.kill()` only** — never `reader.cancel()`, never `for await…break`, never hand `proc.stdout` to anything. On `ws.close` call `proc.kill()`; the pending `read()` then resolves `done`. Add an integration guard mirroring `transcode-stream-client-disconnect.test.ts` but for the WS path (kill-on-close, assert no crash).

### C2 — Feed to `VideoDecoder` must be access units, not individual NALs; plan's "NAL splitter" as described will fail decoder config/decode
**Claim (plan):** `nal-splitter.ts` "split NAL units on Annex-B start codes; send binary WS frames"; frontend feeds `EncodedVideoChunk` from "WS frames."
**Failure scenario:** WebCodecs `VideoDecoder` consumes **one access unit (one frame) per `EncodedVideoChunk`**, not one NAL. If each NAL becomes its own chunk: (a) SPS(7)/PPS(8) fed as standalone chunks → decode errors; (b) a frame split across chunks → corrupt/garbage; (c) `type:'key'` vs `'delta'` misclassified because a lone slice NAL lacks the SPS/PPS context. Also the plan sends "SPS/PPS + first keyframe" as separate frames to late joiners — in Annex-B mode those must be **concatenated into the first key chunk**, not sent as three chunks.
**Evidence:** WebCodecs H.264 semantics; nothing in phase-01 assembles NALs into AUs.
**Mitigation (must-fix):** `nal-splitter` must (1) split on start codes, (2) **assemble NALs into access units** (accumulate until the next VCL/AUD boundary), (3) classify an AU as `key` iff it contains an IDR(5), (4) for key AUs prepend cached SPS/PPS. WS sends one binary message = one AU. Client wraps each into a single `EncodedVideoChunk`.

### C3 — WebCodecs config: wrong/absent codec string or wrong Annex-B mode → `configure()` throws, black canvas
**Claim (plan):** `VideoDecoder({codec:'avc1...'})` with `optimizeForLatency`.
**Failure scenario:** Two independent traps. (1) **Codec string** must be full `avc1.PPCCLL` (profile/constraint/level hex, e.g. `avc1.640028`). `encoderArgs('h264_nvenc')`/`libx264` in `ffmpeg-capabilities.ts:31` set **no `-profile`/`-level`**, so the actual profile is encoder-default (nvenc=high, libx264=high) and *unknown at config time*. A hardcoded guess that mismatches the bitstream → decode failure or refusal. (2) **Annex-B vs AVCC**: to feed Annex-B you must configure **without** `description`; if you pass a `description` (avcC) the decoder expects length-prefixed AVCC and Annex-B input silently fails. Browser support for annex-b-input differs (Chrome/Edge OK; Safari's WebCodecs H.264 is stricter and may require AVCC + description).
**Evidence:** `ffmpeg-capabilities.ts:31` (no profile flags); WebCodecs spec (description-absent ⇒ Annex-B).
**Mitigation (must-fix):** Derive the codec string from the actual SPS (parse profile_idc / constraint_flags / level_idc from the cached SPS NAL) OR force `-profile:v` + `-level` in the encoder-args wrapper and compute the string deterministically. Configure with **no `description`** (Annex-B). Gate on `VideoDecoder.isConfigSupported(config)` and show a real message on failure. Decide Safari: if targeting it, plan an AVCC path (repackage to length-prefixed + build avcC) — otherwise scope slice to Chromium and say so.

### C4 — Static-token "re-auth" is security theater; a full mouse/keyboard channel goes live on a public URL behind one reusable bearer
**Claim (plan):** "gated behind re-auth + TTL + audit"; `POST /api/remote-desktop/session` "re-auth gate → short-lived session token."
**Failure scenario:** PPM auth is a **single static bearer token** (`auth.ts:20-24`), already sitting in the browser/localStorage and travelling as `?token=` on every WS URL (`isWsUpgradeAuthorized` `index.ts:103-107`). "Re-auth" against that same token proves nothing a token-holder or token-leak doesn't already have — no second factor, no revocation, no per-session identity. Worse: `isWsUpgradeAuthorized` **returns `true` unconditionally when `auth.enabled === false`** (`index.ts:104`). If a user runs PPM with auth off (common on "trusted" LAN, but the Cloudflare tunnel is public), the remote-desktop WS grants **full keyboard/mouse control of the host to any anonymous internet client** that hits `/ws/remote-desktop`. The token also lands in Cloudflare/proxy access logs and browser history (query param) → replayable RAT credential. TTL/audit stubs don't change the entry gate.
**Evidence:** `auth.ts:8-24`; `index.ts:103-107`; named-tunnel already had to enforce its *own* `auth.enabled` check because the middleware passes through when disabled (`named-tunnel.ts:23-30`).
**Mitigation (must-fix):**
- WS handler must **independently reject** when `auth.enabled === false` (do not trust `isWsUpgradeAuthorized`), and require a **single-use, short-TTL session nonce** bound to the connection (mirror `download-token.service` consume-once, not the static token).
- Add a **host-side approval / physical-presence gate**: a desktop notification or on-screen prompt on the host that must be accepted before control is granted (this is the only real barrier under a static-token model, and it matches the "badge: đang bị điều khiển" the spike already calls for). Recommend default = required; flip to remembered-device only after phase-07.
- Keep the config feature-flag **default OFF** until phase-07; document that a public tunnel + auth-off must hard-disable the feature.
- Prefer sending the nonce in the WS subprotocol/first message rather than `?token=` to keep it out of logs (query is unavoidable for the static token but the nonce need not leak too).

---

## HIGH

### H1 — No WS backpressure handling; 1080p H.264 over a Cloudflare tunnel will balloon buffer/latency or drop
**Claim (plan):** "WS binary frames"; latency risk noted only as "+RTT."
**Failure scenario:** gdigrab+encoder produce a steady bitrate; the CF tunnel/WAN drains slower and variably. `ws.send()` with no check keeps buffering (Bun buffers on backpressure) → unbounded memory growth and ever-increasing latency (frames queue behind stale ones), or silent drops that leave the decoder stuck waiting for a keyframe → frozen canvas. Terminal WS (`ws/terminal.ts`) sends tiny payloads and has **no backpressure logic to copy** (verified — plain `ws.send`).
**Evidence:** `ws/terminal.ts:73,79` (unguarded send, low-volume); no `getBufferedAmount` anywhere in ws/.
**Mitigation:** Before each AU, check `ws.getBufferedAmount()` (Bun) against a threshold; when exceeded, **drop delta frames until the next key AU** (never drop the key), and request/force an IDR so the client can resync. Cap bitrate/fps/resolution for the slice (e.g. 1280×720@15-20, `-maxrate`/`-bufsize`). Consider `-tune zerolatency -bf 0` (already planned) plus a modest `-g` (e.g. 30-60) so resync costs ≤2-3s.

### H2 — Orphan ffmpeg + Rust injector on abnormal close / server crash / idle-timeout
**Claim (plan):** "Session owns PID; kill on WS close + TTL sweep."
**Failure scenario:** WS `close` doesn't fire on hard network drop (tunnel death, laptop sleep) until `idleTimeout: 960` (verified `index.ts:900`) — 16 min of a live capture + input injector running unattended. Server crash/exit leaves both children orphaned (matches memory: chat-spawned processes zombie the port; hibernate kills tunnels). The injector is a long-lived child holding a control channel to `SendInput`.
**Evidence:** `index.ts:900` idleTimeout; memory `project_supervisor-probe-handle-inheritance` (orphans wedge ports), `project_hibernate-tunnel-recovery`.
**Mitigation:** (1) Lower per-session idle/heartbeat: app-level ping every ~5s, kill session after ~15s silence — don't rely on 960s. (2) Register both PIDs in a session registry with a `process.on('exit'/'SIGINT'/'SIGTERM')` sweep that `proc.kill()`s all. (3) On Windows consider a Job Object so children die with the parent, or at least verify `proc.kill()` reaches ffmpeg (direct child = OK). (4) TTL timer independent of WS state. Success criterion "no orphan proc (tasklist)" must be tested on *abnormal* close (kill the tunnel), not just window-close.

### H3 — Coordinate mapping: normalize-to-virtual-screen vs capture-primary mismatch + `devicePixelRatio` red herring → cursor offset
**Claim (plan):** "Absolute coords via `MOUSEEVENTF_ABSOLUTE|MOVE` normalized to 0..65535 of virtual screen"; client "map client coords → canvas/display coords via bounding rect + `devicePixelRatio`."
**Failure scenario:** `MOUSEEVENTF_ABSOLUTE` maps 0..65535 across the **entire virtual screen** (all monitors, origin at primary top-left, negatives possible on left/upper monitors). But the slice **captures the primary display only**. If the primary isn't the whole virtual desktop (multi-monitor, or gdigrab `-i desktop` actually grabbing the whole virtual desktop — verify which), every click lands offset/scaled. Separately, the client `devicePixelRatio` is the *viewer* device's DPI (e.g. a retina phone) — it has **nothing to do with host pixel coordinates**; folding it into the mapping double-scales and misplaces the cursor. What matters is host capture resolution vs the canvas element's CSS size (via `getBoundingClientRect`), plus the host's virtual-screen geometry for the 0..65535 normalization.
**Evidence:** Win32 SendInput absolute-coord semantics (virtual screen); phase-01 "primary display only"; spike DPI note (`SetProcessDpiAwarenessContext` once).
**Mitigation:** Pin the slice to a single, well-defined capture rect and pass its geometry (x/y/w/h in virtual-screen space) to the injector so it can map `frac → virtualScreen → 65535`. Client mapping = `(clientX - rect.left)/rect.width` → fraction; **drop `devicePixelRatio` from the formula**. Make the injector DPI-per-monitor-v2 aware (once) so host coords are physical pixels matching gdigrab. Verify gdigrab `-i desktop` extent on a multi-monitor host before assuming "primary only."

### H4 — Stuck modifiers on lost keyup
**Claim (plan):** key down/up by VK; no modifier-state handling.
**Failure scenario:** Client sends `keydown Shift` then focus leaves the canvas / WS drops / tab hidden before `keyup` → host keeps Shift/Ctrl/Alt logically held → subsequent local typing on the host is corrupted; classic remote-desktop bug.
**Evidence:** general SendInput behavior; no mitigation in phase.
**Mitigation:** On session end, WS close, canvas blur, and `visibilitychange→hidden`, send a "release all modifiers" (force keyup for Shift/Ctrl/Alt/Win/CapsLock state). Track held keys server-side and flush on teardown. Add a periodic modifier-sanity reset.

### H5 — Bundled unsigned Rust `SendInput` helper → SmartScreen/Defender/EDR quarantine on install
**Claim (plan):** build `remote-desktop-helper-win-x64.exe`, bundle into the npm package.
**Failure scenario:** An unsigned exe delivered via `npm i -g` that injects synthetic input is textbook RAT behavior; SmartScreen and some EDR quarantine it, and the spike already flagged AV risk for the SYSTEM path. This host runs 4 anti-cheat kernel drivers (memory `reference_gaming-pc-kernel-driver-clutter`) — elevated false-positive surface. If quarantined, input silently fails.
**Evidence:** spike "AV/EDR may flag…"; memory hardware/driver clutter.
**Mitigation for the slice:** Reconsider Bun FFI to `user32!SendInput` for phase-01 (no separate binary, no build step, no bundled exe to quarantine) — the plan rejects it for DRY with phase-02, but phase-02 needs a *SYSTEM* helper anyway (different process/token), so the phase-01 injector is not obviously reused as-is. At minimum: plan code-signing (deferred to phase-06 per plan) and document the unsigned-slice caveat; don't let an AV quarantine masquerade as a coord bug during E2E.

---

## MED

### M1 — WS dispatch default falls through to the terminal (shell) handler
**Claim (plan):** add `type === "remote-desktop"` cases to open/message/close.
**Failure scenario:** dispatch uses `else terminalWebSocket.*` as the default in all three handlers (`index.ts:902-922`). If any one of open/message/close misses the new branch (easy to forget close), a remote-desktop socket routes to the terminal handler → in the worst case spawns/handles a shell on a control socket.
**Evidence:** `index.ts:906,914,921` (`else terminal…`).
**Mitigation:** Add explicit `remote-desktop` branches to **all three**; better, change the default from "terminal" to an explicit reject/no-op and make terminal its own `else if`. Set `data:{type:"remote-desktop", sessionId}` at upgrade.

### M2 — Session nonce via `?token=` still leaks; and `POST /session` under auth-off returns 403 but WS may not
**Claim:** route mirrors `named-tunnel.ts` guard.
**Failure scenario:** If only the REST route enforces `auth.enabled` (like `named-tunnel.ts:23-30`) but the WS upgrade trusts `isWsUpgradeAuthorized`, an attacker skips the REST call and hits the WS directly. Also the nonce in query lands in logs.
**Mitigation:** Covered by C4 — enforce in the WS handler too; consume-once nonce; keep it out of query where feasible.

### M3 — ffmpeg encoder-args reuse drags in file-playback tuning, not capture tuning
**Claim (plan):** reuse `encoderArgs()` + add low-latency flags.
**Failure scenario:** `encoderArgs` targets "watch a file" (e.g. nvenc `-rc vbr -cq 26 -b:v 0`, libx264 `-crf 23 -maxrate 8M -bufsize 16M`) — VBR/large bufsize fights zerolatency and inflates latency spikes. Blindly layering `-tune zerolatency` may conflict with `-rc vbr`.
**Mitigation:** For capture, prefer CBR-ish low-latency: nvenc `-rc cbr -tune ll/ull -zerolatency 1 -bf 0`, libx264 `-tune zerolatency -bf 0 -g N`. Keep the *encoder selection* from caps but use a capture-specific arg set (the plan's separate `remote-desktop-encoder-args.ts` is the right seam — just don't inherit the file-playback numbers).

### M4 — "One session per host, closes previous on new session" is a self-DoS / race
**Failure scenario:** two tabs / a reconnect storm each open a session and evict the other in a loop; also a stale session's teardown racing a new one's capture can leave both ffmpegs briefly live (gdigrab contention).
**Mitigation:** Serialize session create/teardown (await previous kill before spawning next); debounce reconnects; make eviction explicit and logged.

### M5 — PPM_HOME / spawn-per-tick compliance: OK, with one caveat
**Assessment:** injector = one long-lived child (complies with system-metrics policy); ffmpeg = per-session not per-tick (fine); no `~/.ppm` writes; gdigrab doesn't touch PPM dir. **No PPM_HOME violation found.** Caveat: the bundled-binary path must resolve from the package install dir, and any temp/scratch (none planned) must go through `getPpmDir()` if added.
**Evidence:** CLAUDE.md system-metrics single-PowerShell rule; plan mirrors it.

---

## LOW

- **L1 — Firefox/WebCodecs gate:** handled (capability guard). Also gate Safari explicitly (see C3).
- **L2 — gdigrab captures overlapping windows / cursor:** acceptable for slice per plan; note `-draw_mouse 1` default draws the host cursor, which may double with a client-side cursor.
- **L3 — Audit log is a stub in the slice:** fine, but ensure the *entry gate* (C4) isn't also a stub.
- **L4 — `SetProcessDpiAwarenessContext` E_ACCESSDENIED on 2nd call:** already captured from spike; ensure the injector calls it exactly once at startup, before any coord use.

---

## Must-fix before cook (top 5)
1. **C1 — WS teardown = `proc.kill()` only.** Manual `getReader()` + pull loop; never `reader.cancel()` / `for await…break` / stdout→Response. Add a WS-path disconnect guard test.
2. **C2/C3 — Access-unit framing + correct WebCodecs config.** Assemble NALs into AUs (one AU per WS message), classify key by IDR, prepend cached SPS/PPS to key AUs; derive `avc1.PPCCLL` from the SPS (or force `-profile/-level`), configure Annex-B (no `description`), gate on `isConfigSupported`.
3. **C4 — Real entry gate, not static-token theater.** WS independently rejects when `auth.enabled===false`; single-use short-TTL nonce bound to the connection; **host-side approval/presence prompt** before control; feature flag default OFF until phase-07.
4. **H1 — WS backpressure.** `getBufferedAmount` threshold → drop deltas to next key + force IDR; cap the slice at 720p/15-20fps CBR-ish.
5. **H2/H3 — Deterministic teardown + correct coord mapping.** App-level heartbeat (~15s) + exit-hook PID sweep so no orphan ffmpeg/injector on tunnel death; map via canvas `getBoundingClientRect` → capture-rect geometry → 65535 virtual-screen, **drop client `devicePixelRatio`**, verify gdigrab extent on multi-monitor.

## Scope-realism note
Phase-01 as written bundles: AU assembly + WebCodecs correctness + Rust toolchain/bundled-exe + backpressure + coord mapping + WS wiring + host-approval gate. That is not a ~2-day slice, and "screenshot-able" is at risk if input+security are in the critical path. **Recommend splitting:** 1a = video-only pipe (capture→AU→WS→WebCodecs→canvas) — this is the true "buildable now + screenshot" milestone and de-risks C1-C3/H1 in isolation; 1b = input injector + host-approval gate + coord mapping (H3/H4/H5, C4). Consider Bun FFI `user32!SendInput` for 1b to drop the Rust build step from the slice (H5), since phase-02 needs a *different* SYSTEM-token helper anyway.

## Unresolved questions
1. Does gdigrab `-i desktop` grab the whole virtual desktop or the primary only on this multi-monitor host? (Decides H3 mapping.) — verify empirically before wiring coords.
2. Is Safari a target for V1? If yes, an AVCC/description path is required (C3) — extra work not in the plan.
3. Host-approval UX: silent-if-token vs always-prompt vs remember-device — a security/product call; recommend always-prompt default for V1 given static-token auth (C4).
4. Will the unsigned bundled injector survive Defender/SmartScreen on end-user machines, or must signing (phase-06) precede any real distribution of the input half? (H5)
