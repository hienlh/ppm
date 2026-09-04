import { describe, it, expect } from "bun:test";
import { formatRam, formatBps } from "../../../src/web/lib/format-bytes.ts";

describe("formatRam", () => {
  it("renders MB below 1024", () => {
    expect(formatRam(0)).toBe("0 MB");
    expect(formatRam(512)).toBe("512 MB");
    expect(formatRam(1023)).toBe("1023 MB");
  });

  it("renders GB with 1 decimal at/above 1024", () => {
    expect(formatRam(1024)).toBe("1.0 GB");
    expect(formatRam(1587)).toBe("1.5 GB");
  });
});

describe("formatBps", () => {
  it("renders B/s below 1024", () => {
    expect(formatBps(0)).toBe("0 B/s");
    expect(formatBps(512)).toBe("512 B/s");
  });

  it("renders KB/s with 1 decimal between 1024 and 1MB", () => {
    expect(formatBps(1024)).toBe("1.0 KB/s");
    expect(formatBps(1536)).toBe("1.5 KB/s");
  });

  it("renders MB/s between 1MB and 1GB", () => {
    expect(formatBps(1024 * 1024)).toBe("1.0 MB/s");
  });

  it("renders GB/s at/above 1GB", () => {
    expect(formatBps(1024 * 1024 * 1024 * 2)).toBe("2.0 GB/s");
  });
});
