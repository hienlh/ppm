import { describe, it, expect } from "bun:test";
import {
  formatDiskCell,
  formatGpuCell,
  formatNetCell,
  sumOptionalBps,
} from "../../../src/web/components/system/process-row-format.ts";

describe("formatDiskCell", () => {
  it("renders an em dash when neither side is measured", () => {
    expect(formatDiskCell(undefined, undefined)).toBe("—");
  });

  it("renders both arrows with the measured values", () => {
    expect(formatDiskCell(1024, 512)).toBe("↓ 1.0 KB/s ↑ 512 B/s");
  });

  it("treats a missing single side as 0, not a dash", () => {
    expect(formatDiskCell(1024, undefined)).toBe("↓ 1.0 KB/s ↑ 0 B/s");
  });
});

describe("formatNetCell", () => {
  it("renders an em dash when neither side is measured", () => {
    expect(formatNetCell(undefined, undefined)).toBe("—");
  });

  it("renders both arrows with the measured values", () => {
    expect(formatNetCell(2048, 1024)).toBe("↓ 2.0 KB/s ↑ 1.0 KB/s");
  });
});

describe("formatGpuCell", () => {
  it("renders an em dash when neither half is measured", () => {
    expect(formatGpuCell(undefined, undefined)).toBe("—");
  });

  it("renders percent and memory together", () => {
    expect(formatGpuCell(12, 1126)).toBe("12% · 1.1 GB");
  });

  it("dashes only the unmeasured half (e.g. NVIDIA consumer: memory but no per-process %)", () => {
    expect(formatGpuCell(undefined, 512)).toBe("— · 512 MB");
    expect(formatGpuCell(50, undefined)).toBe("50% · —");
  });
});

describe("sumOptionalBps", () => {
  it("returns undefined only when both sides are unmeasured", () => {
    expect(sumOptionalBps(undefined, undefined)).toBeUndefined();
  });

  it("treats a missing single side as 0", () => {
    expect(sumOptionalBps(100, undefined)).toBe(100);
    expect(sumOptionalBps(undefined, 50)).toBe(50);
  });

  it("sums both sides when both are measured", () => {
    expect(sumOptionalBps(100, 50)).toBe(150);
  });
});
