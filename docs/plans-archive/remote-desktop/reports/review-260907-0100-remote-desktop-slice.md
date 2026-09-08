# Remote Desktop Vertical Slice — Production-Readiness Review

Branch: `feat/remote-desktop-slice` (4 commits) · Diff base: `main` · Reviewer: staff eng, code-review
Scope: ~1619 LOC across 32 files (services + WS/REST routes + web UI + tests). Live gdigrab→WebCodecs path NOT run.

## Verdict

**Ship as prototype only after fixing R1 (blocking).** The red-team must-fixes are, structurally, almost all present and correctly reasoned — but the encoder is configured in a way that **breaks the access-unit assembler on any real multi-core host**, so the happy-path video will not decode as written. Fix R1; strongly recommend R2. Everything else is prototype-acceptable with the residual notes below.

## Red-team must-fix verification (file:line + PASS/PARTIAL/FAIL)

| ID | Verdict | Evidence |
|----|---------|----------|
| **C1** ffmpeg stdout via manual getReader() loop; proc.kill() on close; never reader.cancel()/stdout→Response | **PASS** | `remote-desktop-capture.ts:86-96` manual `getReader()` pull loop, detached, no cancel. `stop()` → `proc.kill()` only (`:64-68`). No `Response(proc.stdout)`. Session close→`capture.stop()` (`remote-desktop-session.ts:93`). |
| **C2** byte stream → ACCESS UNITS (not per-NAL); key=IDR(5); SPS(7)/PPS(8) cached+prepended | **PASS (structure) but BROKEN by encoder flags — see R1** | `access-unit-assembler.ts:43-89` groups NALs into AUs; `isKey` = contains IDR (`:73`); SPS/PPS cached (`:47-48`) and backfilled onto key AUs (`:79-84`). Logic is correct **only for one-slice-per-frame**, which `-tune zerolatency` violates. |
| **C3** avc1 codec string from real SPS; Annex-B (no `description`); isConfigSupported gate | **PASS** | `avc1-codec-string.ts:11-17` derives `avc1.PPCCLL` from SPS[1..3]. Client passes no `description` and gates on `VideoDecoder.isConfigSupported` (`use-h264-canvas-decoder.ts:46-53`). |
| **C4** WS independently rejects when auth.enabled===false (no shared helper); nonce NOT in `?token=`; flag default OFF | **PASS** | Upgrade re-checks flag+auth in `index.ts:870-876` (independent of `isWsUpgradeAuthorized`); handler re-checks again in `remote-desktop.ts:36-43`. Nonce is the first WS message, never a query param. Flag default OFF (`remote-desktop-flag.ts:7-10`). Note: coarse PPM token IS still `?token=` (pre-existing, acknowledged) — see S1. |
| **H1** backpressure via getBufferedAmount → drop deltas to next key + force/await key | **PARTIAL** | `remote-desktop-session.ts:120-126` drops deltas above 512KB buffered until next key — memory is bounded and it resyncs. But it **cannot force** a keyframe (raw ffmpeg pipe), so it waits ~2s for the periodic GOP key. Acceptable, but "force key" is not implemented. |
| **H2** teardown: kill ffmpeg on close + heartbeat + process-exit PID sweep | **PASS** | Heartbeat 5s/15s (`:22-23,53,102-107`); close kills capture (`:93`); `registerRemoteDesktopExitSweep()` on exit/SIGINT/SIGTERM (`:154-160`) calls `close()`→sync `proc.kill()`. |
| **H3** coord mapping getBoundingClientRect→0..65535, DROP devicePixelRatio | **PASS** (single-monitor) | `remote-desktop-coords.ts:18-22` uses rect only, never DPR; server maps frac→65535 (`remote-desktop-input.ts:100-101`). Residual multi-monitor gap — see R3. |
| **H4** modifier release-all on blur/hidden/close | **PARTIAL — see R2** | Client releases on blur+visibilitychange+unmount (`use-remote-input-capture.ts:43,52,55-64`); server releases on close (`remote-desktop-session.ts:95-98`). BUT only the 8 **modifier** VKs are released; held **non-modifier** keys stay stuck. |
| **M1** explicit /ws/remote-desktop dispatch, no terminal fallthrough | **PASS** | `index.ts:869-882` explicit upgrade branch; open/message/close now dispatch `terminal` explicitly and `else ws.close(1008,"unknown socket type")` (`:921-950`). Improves on prior terminal-as-default. |

## Findings by severity

### R1 — CRITICAL (blocking): `-tune zerolatency` emits multiple slices per frame → AU assembler splits one frame into many partial access units
- `remote-desktop-encoder-args.ts:26` sets `-tune zerolatency`. x264's zerolatency tune **enables `sliced-threads`**, so on any multi-core host each frame is encoded as N slice NALs (one per thread). Confirmed: sliced-threads is enabled specifically by zerolatency (see Sources).
- `access-unit-assembler.ts:51-56` treats *every* VCL NAL as a new access-unit boundary ("the next VCL NAL after we already buffered one"). Its own header comment (`:6-9`) explicitly assumes "libx264 emits at most one slice NAL per frame" — that assumption is false under the flags it ships with.
- Impact: each frame's slices become separate `EncodedVideoChunk`s. WebCodecs receives partial pictures (only the first slice carries `first_mb_in_slice==0`) → decoder errors or renders corrupt/garbage. On an IDR frame you also emit several `isKey` chunks per picture. This is exactly the untested live-path failure. The test suite reinforces the wrong model: `access-unit-assembler.test.ts:31-41` asserts two consecutive slice NALs become two AUs.
- Fix (pick one): add `-x264-params sliced-threads=0` (keeps the rest of zerolatency), or `-slices 1`, or do real AU-boundary detection via the slice-header `first_mb_in_slice` ue(v). Disabling sliced-threads is the pragmatic prototype fix. Then add a multi-slice fixture to the assembler test.

### R2 — HIGH: held non-modifier keys stay stuck on the host after blur/disconnect
- `remote-desktop-session.ts:83-86,95-98` and `remote-desktop-input.ts:124-130`: `releaseAll`/close only inject keyup for the 8 modifier VKs (`remote-desktop-vk-map.ts:35`). `heldKeyCodes` tracks *all* held keys (`:78`) but is only `.clear()`-ed, never used to release non-modifiers.
- Impact: user holds e.g. `KeyW` (game) or any letter and the tab blurs / link drops → that key remains logically down on the host until the user physically presses it. Real "stuck key" hazard, the exact failure H4 was meant to prevent.
- Fix: on releaseAll/close, iterate `heldKeyCodes` and inject keyup for each (fall back to releaseAllModifiers for the untracked case). The tracking set already exists; wire it to actual release.

### R3 — MEDIUM: multi-monitor coordinate mismatch (capture region vs injection space)
- Injection uses `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` (`remote-desktop-input.ts:102`), mapping 0..65535 across the **entire virtual desktop** (all monitors). gdigrab `-i desktop` capture region and the client canvas fraction are not guaranteed to correspond to that same virtual-desktop rect on a multi-monitor host.
- Impact: on multi-monitor setups the cursor lands offset from where the user clicked. Single-monitor is correct. Note as known limitation or constrain capture+injection to the same rect.

### R4 — MEDIUM: stale/misleading comments on the nonce security path
- `remote-desktop-nonce.ts:8-10`, `routes/remote-desktop.ts:3-6` and `ws/remote-desktop.ts:8-10` all state the nonce is "presented via the WS subprotocol header … consumed exactly once, at upgrade time, in `src/server/index.ts`." The actual implementation consumes it as the **first WS message** in `authenticateFirstMessage` (`ws/remote-desktop.ts:45-53`); `index.ts` does not touch the nonce. Not a functional bug, but misleading comments on an auth path invite a wrong future refactor. Correct the comments to describe the first-message handshake.

### R5 — LOW
- First keyframe is dropped at startup: server sends `{config}` then the key AU immediately, but client `configure()` awaits `isConfigSupported` async, so `decodeAccessUnit` sees `state !== "configured"` and drops the first key (`use-h264-canvas-decoder.ts:89`); next key is ~2s away (GOP 30 @ 15fps) → ~2s black screen. Cosmetic for a prototype.
- No timeout on the un-authenticated WS: a client holding a valid coarse token can open the socket and never send the nonce; no capture starts, but the socket lingers until Bun's 960s idle. Minor DoS surface.
- `injectPointer` with `button:"left", down:null` maps to LEFTUP (`:103`, null is falsy). Only reachable via a malformed client message; harmless but sloppy.
- `stderrTail = new Response(proc.stderr).text()` (`remote-desktop-capture.ts:71`) uses a `Response` around a subprocess pipe — the very pattern the file header warns about, though here it fully drains stderr internally (not tied to a client Response/disconnect) so it should be safe. Verify once on the live path since it was never run.

## Security assessment (control gating on a public tunnel)
Gating layers, defense-in-depth, are sound for a flag-off prototype: feature flag (`REMOTE_DESKTOP_ENABLED`) default OFF → coarse `?token=` WS auth → independent `auth.enabled` re-check at both upgrade and handler → same-origin check on `/session` → single-use 30s nonce as first WS message (kept out of query/logs) → "one session per host" eviction.

- **S1 residual (accept + document):** the coarse PPM bearer token still travels as `?token=` on the WS URL (`remote-desktop-ws-url.ts:12` via `withWsAuth`), so it lands in tunnel/proxy access logs. The short-TTL single-use nonce mitigates replay of that specific channel, but anyone holding the reusable app token + the feature flag on can drive the host. This is acceptable *only* because the flag is off by default and the header (`remote-desktop-flag.ts:1-6`) states host-approval prompt + signed input path are deferred to phase-07. Do not enable the flag on a public tunnel until those land.
- Input validation at the boundary is adequate: `handleClientMessage` type-checks every field (`remote-desktop-session.ts:60-87`) and `codeToVk` returns null for unmapped keys rather than guessing.

## Other checks
- File sizes: all changed files < 200 LOC (largest `remote-desktop-session.ts` 161). PASS project rule.
- Tests: real, not phantom — splitter/assembler/nonce/vk-map/coords/flag covered. Gap: no multi-slice-per-frame fixture (the R1 case), and the existing assembler test encodes the wrong assumption. Concurrency: single-session eviction awaits prior ffmpeg exit with a 2s cap (`:139-143`) — reasonable.
- Backwards compat: WS dispatch change makes `terminal` explicit and unknown types now `close(1008)` instead of falling through to terminal — a safety improvement, no existing socket type regresses.

## Unresolved questions
1. On the target host, how many threads will libx264 use (i.e., how many slices/frame) — confirms R1 severity, though the fix applies regardless.
2. Is gdigrab `-i desktop` intended to capture the full virtual desktop or the primary monitor only? Determines the exact R3 fix.
3. Was `stderr`-via-`Response` (R5) ever exercised under proc.kill() on Bun/Windows, given the known stdout segfault class?

Sources:
- [The Quality Cost of Low-Latency Transcoding — Streaming Learning Center](https://streaminglearningcenter.com/codecs/the-quality-cost-of-low-latency-transcoding.html)
- [Low latency x264 options — OBS Forums](https://obsproject.com/forum/resources/low-latency-high-performance-x264-options-for-for-most-streaming-services-youtube-facebook.726/)
