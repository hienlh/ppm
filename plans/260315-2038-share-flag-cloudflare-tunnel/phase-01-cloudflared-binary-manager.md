---
phase: 1
title: "Cloudflared Binary Manager Service"
status: completed
effort: 1.5h
completed: 2026-03-15
---

# Phase 1: Cloudflared Binary Manager Service

## Context

- [Research report](../reports/researcher-260315-2028-tunnel-share-flag-implementation.md)
- Pattern reference: `src/services/config.service.ts` (singleton service)

## Overview

- **Priority**: P1 (blocking for all other phases)
- **Status**: completed
- Service that ensures `cloudflared` binary is available at `~/.ppm/bin/cloudflared`
- **Implementation**: `src/services/cloudflared.service.ts` created with binary manager, download, and platform detection

## Key Insights

- cloudflared releases on GitHub: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-{os}-{arch}`
- OS mapping: `darwin` -> `darwin`, `linux` -> `linux` (no Windows support needed yet)
- Arch mapping: `x64` -> `amd64`, `arm64` -> `arm64`
- Binary is ~50MB -- must show download progress
- Need to `chmod +x` after download on unix

## Requirements

### Functional
- Detect OS (darwin/linux) and arch (x64/arm64)
- Build correct GitHub release download URL
- Download binary to `~/.ppm/bin/cloudflared` with progress indicator
- Make binary executable (`chmod 755`)
- Skip download if binary already exists
- Return path to binary

### Non-functional
- Download progress shown to user (percentage or spinner)
- Graceful error if unsupported OS/arch
- Graceful error if download fails (network issue)

## Architecture

```
CloudflaredService (singleton)
  |
  +-- ensureCloudflared(): Promise<string>  -- returns path to binary
  |     |-- checks if binary exists at ~/.ppm/bin/cloudflared
  |     |-- if missing: calls downloadBinary()
  |     +-- returns binary path
  |
  +-- getDownloadUrl(): string  -- builds platform-specific URL
  |
  +-- downloadBinary(url, dest): Promise<void>  -- fetch + write + chmod
```

## Related Code Files

- **Create**: `src/services/cloudflared.service.ts`
- **Reference**: `src/services/config.service.ts` (pattern)

## Implementation Steps

1. Create `src/services/cloudflared.service.ts`
2. Define constants:
   - `CLOUDFLARED_DIR = resolve(homedir(), ".ppm", "bin")`
   - `CLOUDFLARED_PATH = resolve(CLOUDFLARED_DIR, "cloudflared")`
3. Implement `getDownloadUrl()`:
   ```typescript
   function getDownloadUrl(): string {
     const platform = process.platform; // "darwin" | "linux"
     const arch = process.arch;         // "x64" | "arm64"
     const osMap: Record<string, string> = { darwin: "darwin", linux: "linux" };
     const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
     const os = osMap[platform];
     const cpu = archMap[arch];
     if (!os || !cpu) throw new Error(`Unsupported platform: ${platform}-${arch}`);
     return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${os}-${cpu}`;
   }
   ```
4. Implement `downloadBinary(url, destPath)`:
   - Use `fetch()` to stream download
   - Read `Content-Length` header for progress
   - Write to temp file first, then rename (atomic)
   - `chmod(destPath, 0o755)` after rename
   - Print progress: `Downloading cloudflared... XX%` (overwrite line with `\r`)
5. Implement `ensureCloudflared()`:
   - Check `existsSync(CLOUDFLARED_PATH)` -- return early if exists
   - Call `getDownloadUrl()` + `downloadBinary()`
   - Return `CLOUDFLARED_PATH`
6. Export singleton: `export const cloudflaredService = new CloudflaredService()`

## Todo List

- [x] Create `src/services/cloudflared.service.ts`
- [x] Implement `getDownloadUrl()` with OS/arch detection
- [x] Implement `downloadBinary()` with progress output
- [x] Implement `ensureCloudflared()` entry point
- [x] Export singleton instance
- [x] Verify `chmod` works on macOS and Linux

## Success Criteria

- Running `ensureCloudflared()` on macOS arm64 downloads correct binary
- Second call skips download (binary already exists)
- Unsupported platform throws clear error message
- Download progress visible in terminal

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| GitHub rate-limits download | Medium | Retry once; clear error message |
| Binary corrupted mid-download | Low | Write to temp file, rename atomically |
| User lacks write permission to ~/.ppm | Low | Error message suggesting `mkdir -p ~/.ppm/bin` |

## Security Considerations

- Download over HTTPS from official GitHub releases only
- No code execution during download -- just binary fetch
- `chmod 755` (not 777)
