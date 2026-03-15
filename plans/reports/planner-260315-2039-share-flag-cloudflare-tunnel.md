# Planner Report: --share Flag (Cloudflare Quick Tunnel)

**Date**: 2026-03-15
**Plan**: `plans/260315-2038-share-flag-cloudflare-tunnel/`

## Summary

4-phase plan for `ppm start --share` using Cloudflare Quick Tunnel (zero config/account/cost). Two new services + minimal integration into existing CLI/server files.

## Phases

1. **Cloudflared Binary Manager** (1.5h) -- `src/services/cloudflared.service.ts` (~120 LOC). Auto-detect OS/arch, download from GitHub releases to `~/.ppm/bin/cloudflared`, show progress, chmod.
2. **Tunnel Service** (1h) -- `src/services/tunnel.service.ts` (~80 LOC). Spawn `cloudflared tunnel --url`, parse trycloudflare.com URL from stderr (two format variants), SIGINT/SIGTERM cleanup.
3. **CLI + Server Integration** (1h) -- Add `-s/--share` to Commander, call tunnel after `Bun.serve()`, print URL. Block `--share --daemon` combo. Tunnel failure = warning, not crash.
4. **Tests** (0.5h) -- Unit tests for URL building (4 platform combos) and stderr URL extraction (2 output formats). Extract pure `extractTunnelUrl()` for testability.

## Key Decisions

- Quick Tunnel only (random URL, no account) -- persistent tunnels = future paid feature
- Daemon + share blocked (tunnel dies with parent process)
- Dynamic import of tunnel service (only loaded when --share used)
- Atomic download (temp file + rename) to prevent corrupted binaries

## Files

| Action | Path |
|--------|------|
| Create | `src/services/cloudflared.service.ts` |
| Create | `src/services/tunnel.service.ts` |
| Modify | `src/index.ts` (+1 option line) |
| Modify | `src/server/index.ts` (+~30 lines) |
| Create | `tests/unit/services/cloudflared.service.test.ts` |
| Create | `tests/unit/services/tunnel.service.test.ts` |

## Total Effort: ~4h
