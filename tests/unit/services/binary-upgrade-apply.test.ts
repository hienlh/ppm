import { describe, it, expect, mock } from "bun:test";
import "../../../tests/test-setup.ts";
import { applyBinaryUpgrade, type BinaryUpgradeDeps } from "../../../src/services/binary-upgrade-apply.ts";

const UPDATE_AVAILABLE = { available: true, current: "1.0.0", latest: "9.9.9" };

/** Build deps with a swap spy + sensible passing defaults, overridable per test. */
function makeDeps(over: Partial<BinaryUpgradeDeps> = {}): BinaryUpgradeDeps & { swapSpy: ReturnType<typeof mock> } {
  const swapSpy = mock(() => {});
  return {
    checkFn: async () => UPDATE_AVAILABLE,
    headCheckFn: async () => true,
    downloadFn: (async () => "/tmp/payload") as any,
    swapFn: swapSpy as any,
    execPath: "/opt/ppm/bin/ppm",
    platform: "linux",
    arch: "x64",
    swapSpy,
    ...over,
  };
}

describe("applyBinaryUpgrade guards", () => {
  it("already latest → no download, no swap", async () => {
    const deps = makeDeps({ checkFn: async () => ({ available: false, current: "9.9.9", latest: "9.9.9" }) });
    const res = await applyBinaryUpgrade(deps);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/latest/);
    expect(deps.swapSpy).toHaveBeenCalledTimes(0);
  });

  it("(a) HEAD 404 → error, swap NOT called", async () => {
    const deps = makeDeps({ headCheckFn: async () => false });
    const res = await applyBinaryUpgrade(deps);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not yet available/);
    expect(deps.swapSpy).toHaveBeenCalledTimes(0);
  });

  it("(c) unsupported platform → clean error, swap NOT called", async () => {
    const deps = makeDeps({ arch: "ia32" });
    const res = await applyBinaryUpgrade(deps);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Unsupported arch/);
    expect(deps.swapSpy).toHaveBeenCalledTimes(0);
  });

  it("(b) incomplete extract → error, swap NOT called", async () => {
    const deps = makeDeps({ downloadFn: (async () => { throw new Error("incomplete extract: web/ missing"); }) as any });
    const res = await applyBinaryUpgrade(deps);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/incomplete/);
    expect(deps.swapSpy).toHaveBeenCalledTimes(0);
  });

  it("(d) checksum mismatch → fatal, swap NOT called", async () => {
    const deps = makeDeps({ downloadFn: (async () => { throw new Error("checksum mismatch: expected x got y"); }) as any });
    const res = await applyBinaryUpgrade(deps);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/checksum/);
    expect(deps.swapSpy).toHaveBeenCalledTimes(0);
  });

  it("(e) missing SHA256SUMS → fatal, swap NOT called", async () => {
    const deps = makeDeps({ downloadFn: (async () => { throw new Error("SHA256SUMS missing entry for artifact"); }) as any });
    const res = await applyBinaryUpgrade(deps);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/SHA256SUMS/);
    expect(deps.swapSpy).toHaveBeenCalledTimes(0);
  });

  it("(f) happy path → swap called once, returns new version", async () => {
    const deps = makeDeps();
    const res = await applyBinaryUpgrade(deps);
    expect(res).toEqual({ success: true, newVersion: "9.9.9" });
    expect(deps.swapSpy).toHaveBeenCalledTimes(1);
  });
});
