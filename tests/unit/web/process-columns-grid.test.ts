import { describe, it, expect } from "bun:test";
import {
  buildProcessGrid,
  optionalCellClassName,
} from "../../../src/web/components/system/process-columns-grid.ts";

describe("buildProcessGrid — wide template", () => {
  it("includes only the enabled optional columns, in disk/gpu/net order", () => {
    const grid = buildProcessGrid({ disk: true, gpu: false, net: true }, null);
    expect(grid.wideTemplate).toBe("minmax(0,1fr) 64px 80px 120px 120px 130px 44px");
  });

  it("includes no optional tracks when all columns are disabled (e.g. light tier)", () => {
    const grid = buildProcessGrid({ disk: false, gpu: false, net: false }, null);
    expect(grid.wideTemplate).toBe("minmax(0,1fr) 64px 80px 130px 44px");
  });

  it("includes every optional track when all three are enabled", () => {
    const grid = buildProcessGrid({ disk: true, gpu: true, net: true }, null);
    expect(grid.wideTemplate).toBe("minmax(0,1fr) 64px 80px 120px 90px 120px 130px 44px");
  });
});

describe("buildProcessGrid — narrow template + narrowExtra", () => {
  it("has no optional track and no trend track when nothing is sorted", () => {
    const grid = buildProcessGrid({ disk: true, gpu: true, net: true }, null);
    expect(grid.narrowTemplate).toBe("minmax(0,1fr) 64px 80px 44px");
    expect(grid.narrowExtra).toBeNull();
  });

  it("surfaces the sorted optional column when it is enabled", () => {
    const grid = buildProcessGrid({ disk: true, gpu: true, net: true }, "gpu");
    expect(grid.narrowExtra).toBe("gpu");
    expect(grid.narrowTemplate).toBe("minmax(0,1fr) 64px 80px 90px 44px");
  });

  it("does not surface a sort key whose column is disabled on this host", () => {
    const grid = buildProcessGrid({ disk: true, gpu: false, net: true }, "gpu");
    expect(grid.narrowExtra).toBeNull();
    expect(grid.narrowTemplate).toBe("minmax(0,1fr) 64px 80px 44px");
  });

  it("ignores non-optional sort keys (cpu/ram/name)", () => {
    const grid = buildProcessGrid({ disk: true, gpu: true, net: true }, "cpu");
    expect(grid.narrowExtra).toBeNull();
  });

  it("does not surface gpuMem — no header ever sorts by it directly", () => {
    const grid = buildProcessGrid({ disk: true, gpu: true, net: true }, "gpuMem");
    expect(grid.narrowExtra).toBeNull();
  });
});

describe("optionalCellClassName", () => {
  it("is always visible (no `hidden`) when it is the narrow-mode survivor", () => {
    const grid = buildProcessGrid({ disk: true, gpu: true, net: true }, "disk");
    expect(optionalCellClassName(grid, "disk")).toBe("block");
  });

  it("is hidden below @lg otherwise", () => {
    const grid = buildProcessGrid({ disk: true, gpu: true, net: true }, "disk");
    expect(optionalCellClassName(grid, "gpu")).toBe("hidden @lg:block");
    expect(optionalCellClassName(grid, "net")).toBe("hidden @lg:block");
  });
});
