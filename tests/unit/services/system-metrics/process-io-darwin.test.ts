/** Per-process disk bytes on macOS: `proc_pid_rusage(RUSAGE_INFO_V2)` over FFI. */
import { describe, expect, test } from "bun:test";
import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  darwinProcessDiskIo, parseRusageDiskIo, RUSAGE_INFO_V2_BYTES,
} from "../../../../src/services/system-metrics/process-io-darwin.ts";

/** A `struct rusage_info_v2` with its last three u64s set. */
function rusage(childElapsed: bigint, read: bigint, written: bigint, pad = 0): Uint8Array {
  const bytes = new Uint8Array(pad + RUSAGE_INFO_V2_BYTES);
  const v = new DataView(bytes.buffer, pad);
  v.setBigUint64(136, childElapsed, true);
  v.setBigUint64(144, read, true);
  v.setBigUint64(152, written, true);
  return bytes.subarray(pad);
}

describe("parseRusageDiskIo", () => {
  test("reads ri_diskio_bytesread and ri_diskio_byteswritten, not their neighbour", () => {
    expect(parseRusageDiskIo(rusage(7n, 5_000_000_000n, 33_554_432n))).toEqual({
      readBytes: 5_000_000_000,
      writeBytes: 33_554_432,
    });
  });

  test("a buffer that is a view into a larger one is read at its own offset", () => {
    expect(parseRusageDiskIo(rusage(7n, 1n, 2n, 24))).toEqual({ readBytes: 1, writeBytes: 2 });
  });

  test("a buffer shorter than the struct is not read", () => {
    expect(parseRusageDiskIo(new Uint8Array(RUSAGE_INFO_V2_BYTES - 8))).toBeUndefined();
  });
});

describe.if(process.platform === "darwin")("darwinProcessDiskIo on this Mac", () => {
  test("a synced write moves this process's written bytes by at least its size", () => {
    const dir = mkdtempSync(join(tmpdir(), "ppm-rusage-"));
    try {
      const before = darwinProcessDiskIo(process.pid)!;
      const fd = openSync(join(dir, "blob"), "w");
      writeSync(fd, new Uint8Array(8 * 1024 * 1024).fill(1));
      fsyncSync(fd);
      closeSync(fd);
      const after = darwinProcessDiskIo(process.pid)!;
      expect(after.writeBytes - before.writeBytes).toBeGreaterThanOrEqual(8 * 1024 * 1024);
      expect(after.readBytes).toBeGreaterThanOrEqual(before.readBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.if(process.getuid?.() !== 0)("another user's process is refused, not read as 0", () => {
    // launchd runs as root.
    expect(darwinProcessDiskIo(1)).toBeUndefined();
  });

  test("a pid that does not exist has no figures", () => {
    expect(darwinProcessDiskIo(2_000_000)).toBeUndefined();
  });
});
