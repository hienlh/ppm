import { describe, test, expect } from "bun:test";
import { parseProcIo, readProcIoBytes } from "../../../../src/services/system-metrics/process-io-linux.ts";

// Verbatim /proc/<pid>/io from a Debian container.
const PROC_IO = `rchar: 323934931
wchar: 323929600
syscr: 632687
syscw: 632675
read_bytes: 4096000
write_bytes: 2093056
cancelled_write_bytes: 8192
`;

describe("parseProcIo", () => {
  test("reads the block-layer counters, not the page-cache ones", () => {
    // rchar/wchar are the deliberately-ignored cache figures.
    expect(parseProcIo(PROC_IO)).toEqual({ readBytes: 4096000, writeBytes: 2093056 });
  });

  test("a partially populated file still yields the half it has", () => {
    expect(parseProcIo("read_bytes: 512\n")).toEqual({ readBytes: 512, writeBytes: 0 });
    expect(parseProcIo("write_bytes: 512\n")).toEqual({ readBytes: 0, writeBytes: 512 });
  });

  test("a file with neither counter is 'unknown', not 'zero'", () => {
    expect(parseProcIo("rchar: 12\nwchar: 13\n")).toBeNull();
    expect(parseProcIo("")).toBeNull();
    expect(parseProcIo("read_bytes: notanumber\n")).toBeNull();
  });
});

describe("readProcIoBytes", () => {
  test("an unreadable /proc/<pid>/io (EACCES for another user, ENOENT after exit) returns null and never throws", () => {
    // pid 0 has no /proc entry on any platform, and on non-Linux the whole path
    // is absent — both must degrade to null rather than kill the tick.
    expect(readProcIoBytes(0)).toBeNull();
    expect(readProcIoBytes(2 ** 31 - 1)).toBeNull();
  });
});
