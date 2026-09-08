# Phase 08 — Tests

## Context
- Tests run via `bun test`; host Bun segfaults on some suites → use Docker oven/bun runner
  (memory `project_bun-crash-docker-tests`). Existing guard example:
  `tests/integration/transcode-stream-client-disconnect.test.ts`.

## Test matrix
| Target | Type | What it proves |
|--------|------|----------------|
| `nal-splitter.ts` | unit | Annex-B split + SPS/PPS/IDR classification from a captured H264 blob |
| `remote-desktop-encoder-args.ts` | unit | low-latency flags appended to `encoderArgs()` per encoder |
| capture argv builders (win/mac/linux) | unit | correct gdigrab/avfoundation/x11grab argv (pure fns) |
| `input-command-schema.ts` | unit | validate/reject malformed input; coord normalization math |
| code→scancode map | unit | round-trip for representative keys; Unicode path |
| capture proc lifecycle | integration | wrapper pattern kills ffmpeg on WS close (no orphan); no Bun segfault on disconnect (mirror transcode-stream test) |
| session-token | unit | TTL expiry, single-use, replay rejected |
| route guards | integration | session creation refused without auth/same-origin; bot start refused |
| WS auth | integration | `/ws/remote-desktop` rejects missing/expired token (uses `isWsUpgradeAuthorized`) |
| audit log | unit | start/stop/counts recorded |
| protected-PID guard | unit | refuses injecting into PPM/supervisor PIDs |

## Manual / E2E (cannot unit-test native privileged paths)
- Slice E2E (phase 01): open window, see desktop, click, type into Notepad; close → no orphans.
- Service (phase 02): install service, lock machine, verify normal-desktop control; verify UAC
  secure-desktop → overlay (not black) + input disabled.
- Per-OS smoke (phases 04/05) on real machines/VMs (NOT WSL for Linux).
- Self-e2e browser harness where possible (memory `feedback_self-e2e-browser`): puppeteer + token
  from `ppm.dev.db` → localStorage; assert canvas receives frames.

## Steps
1. Write pure-fn unit tests first (argv, NAL, schema, token) — no native/proc needed.
2. Integration: proc lifecycle + WS auth + route guards (Docker bun runner).
3. Manual E2E checklists per phase; record latency numbers.

## Success criteria
- All new unit + integration tests green in Docker bun runner; no new segfault.
- Manual E2E checklists pass on Windows (slice + service).

## Unresolved questions
1. How to CI the native helper (Rust) build + a headless capture smoke test?
2. Acceptable latency budget over CF tunnel to call the feature "done"?
