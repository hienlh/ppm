# Binary Self-Upgrade: Ship Without Landing on Your Feet

**Date**: 2026-07-24 17:00
**Severity**: Medium
**Component**: Upgrade Service, Binary Distribution, Cross-Platform
**Status**: Resolved

## What Happened

Shipped in-app self-upgrade for binary-installed PPM (GitHub release archives on Linux/macOS/Windows). Previously `applyUpgrade()` hard-blocked non-npm installs with "binary installs cannot self-upgrade." Now they can — full end-to-end: detect → download → verify → extract → swap → restart.

Commit `224efc8`. 61 tests (Docker-based; host Bun segfaults on `bun test`). Added 5 new service modules + release.sh SHA-256 generation.

## The Brutal Truth

This is a relief because "binary installs can't upgrade themselves" was a shipping blocker for the standalone binary feature. But it's also loaded with cross-platform landmines: Windows file locking, atomic swaps, the joy of tar.gz vs. zip layouts, and the fact that if the swap fails partway through, you can be left with no executable at all.

The code is defensive—lots of try/finally and explicit rollback on Windows—but that defensiveness exists *because we almost shipped without it*. Initial code review flagged: "web/ swap should precede binary swap so a web failure never orphans the binary." Caught it. Would've been awful in the field.

## Technical Details

**DI Seam to Break a Cycle**

`applyBinaryUpgrade()` injects `checkFn` rather than importing `checkForUpdate` from `upgrade.service.ts`. This is pure DI discipline: avoid circular imports by inverting the dependency. The other functions (`headCheckFn`, `downloadFn`, `swapFn`) are also optional overrides—testable without real network/filesystem ops.

**Mandatory SHA-256 Verification**

Download verifies against a published `SHA256SUMS` manifest **before extraction**. No fallback for missing checksums—it's fatal. `release.sh` now generates and uploads the manifest alongside binaries. Trade-off: users upgrading FROM a pre-checksum release will need a one-time manual reinstall.

**Cross-Platform Atomic Swap**

- **Unix**: Overwrite the running binary in place. The process keeps its open inode; re-spawn loads the new file. Simple. chmod 0o755 the new binary.
- **Windows**: The running `.exe` is locked. Rename it to `.old`, drop the new one in place, and if that fails, restore the `.old` one so you never leave no executable. Supervisor cleanup removes `.old` files at boot.

Also: tar.gz extracts flat (`./ppm`, `./web`), but Windows zip has a top-level dir (`ppm-windows-x64/ppm.exe`). Solved with a depth-≤1 payload-root search rather than assuming extract layout.

**Fetch Timeouts Added**

10s for HEAD checks (verify asset exists), 120s for archive download (large files on slow connections). Guards against stalled downloads hanging the process while holding the in-progress lock.

## What We Tried

Initial implementation didn't swap `web/` before the binary. Code review flagged: "web failure will orphan the binary." Reordered. Added Windows rollback: if `renameSync(newBinary, execPath)` fails, restore the old binary before throwing. Tests validate both Unix and Windows paths via injected `platform` param.

## Root Cause Analysis

Why this took 5 modules instead of 1? The domains are genuinely separate:
- **Artifact**: platform/arch → GitHub release asset naming
- **Download**: HTTP + SHA-256 verification
- **Swap**: atomic rename + platform-specific locking behavior
- **Apply**: orchestrate the above + cleanup

Bundling them would've hidden the fact that swap is *dramatically* different on Windows (rename-aside + rollback) vs. Unix (in-place overwrite). Keeping them separate made the asymmetry explicit.

## Lessons Learned

1. **DI for cyclic dependencies saves refactor debt.** Don't reach for "just import both ways" when you can inject one side. Costs nothing now, saves a refactor later.
2. **Cross-platform atomicity is not symmetric.** Don't assume Unix patterns work on Windows. File locking, in-place overwrites, and cleanup strategy all flip. Document the asymmetry in code comments.
3. **"Never leave a broken state" is not free.** The Windows rollback adds code. The reordering (web before binary) adds subtle ordering logic. But the alternative—a binary install with no executable—is unrecoverable in the field. Worth the cost.
4. **Test via Docker when host tools break.** Bun segfaults on `bun test`. Rather than debug the segfault, run the suite in `oven/bun:1.2`. All 61 tests pass. Move on.

## Next Steps

- Ship feedback cycle: monitor for upgrade-related crashes on binary installs (GitHub issues, telemetry).
- If a pre-checksum release user reports "upgrade stuck," confirm they need a manual reinstall; document the one-time migration path.
- Future: Consider a transparent migration helper that auto-invokes after detecting a stale pre-checksum binary.
