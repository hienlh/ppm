import { describe, it, expect } from "bun:test";
import {
  DEFAULT_EDGE_RECYCLE_MB,
  EDGE_RECYCLE_MB_ENV,
  EDGE_RECYCLE_QUIET_CONNECTIONS,
  edgeOverLimit,
  edgeRecycleLimitMB,
  shouldRecycleEdge,
} from "../../../src/services/edge-recycle-policy.ts";
import { readNativeMemory, readProcessPrivateMB } from "../../../src/services/memory-diagnostics-native.ts";

describe("edgeRecycleLimitMB", () => {
  it("defaults to 1.5 GB on Windows", () => {
    expect(edgeRecycleLimitMB({}, "win32")).toBe(DEFAULT_EDGE_RECYCLE_MB);
    expect(DEFAULT_EDGE_RECYCLE_MB).toBe(1536);
  });

  it("is off where the OS reports no per-process commit, whatever the env says", () => {
    expect(edgeRecycleLimitMB({}, "linux")).toBeNull();
    expect(edgeRecycleLimitMB({ [EDGE_RECYCLE_MB_ENV]: "2048" }, "darwin")).toBeNull();
  });

  it("takes the env override, and 0 turns it off", () => {
    expect(edgeRecycleLimitMB({ [EDGE_RECYCLE_MB_ENV]: "2048" }, "win32")).toBe(2048);
    expect(edgeRecycleLimitMB({ [EDGE_RECYCLE_MB_ENV]: " 900 " }, "win32")).toBe(900);
    expect(edgeRecycleLimitMB({ [EDGE_RECYCLE_MB_ENV]: "0" }, "win32")).toBeNull();
  });

  it("falls back to the default for a value that is not a size", () => {
    for (const bad of ["abc", "-5", "", "  "]) {
      expect(edgeRecycleLimitMB({ [EDGE_RECYCLE_MB_ENV]: bad }, "win32")).toBe(DEFAULT_EDGE_RECYCLE_MB);
    }
  });
});

describe("shouldRecycleEdge", () => {
  it("recycles over the limit at a quiet moment", () => {
    expect(shouldRecycleEdge(1600, 0, 1536)).toBe(true);
    expect(shouldRecycleEdge(1536, EDGE_RECYCLE_QUIET_CONNECTIONS, 1536)).toBe(true);
  });

  it("waits while more clients are connected than the quiet count", () => {
    expect(shouldRecycleEdge(5000, EDGE_RECYCLE_QUIET_CONNECTIONS + 1, 1536)).toBe(false);
  });

  it("never recycles under the limit, without a reading, or when off", () => {
    expect(shouldRecycleEdge(1535, 0, 1536)).toBe(false);
    expect(shouldRecycleEdge(undefined, 0, 1536)).toBe(false);
    expect(shouldRecycleEdge(9999, 0, null)).toBe(false);
  });

  it("counts an unknown reading as not over the limit", () => {
    expect(edgeOverLimit(undefined, 1536)).toBe(false);
    expect(edgeOverLimit(2000, null)).toBe(false);
    expect(edgeOverLimit(2000, 1536)).toBe(true);
  });
});

describe("readProcessPrivateMB", () => {
  it("answers undefined off Windows instead of guessing from RSS", async () => {
    expect(await readProcessPrivateMB(process.pid, "linux")).toBeUndefined();
  });

  it("answers undefined for a pid that cannot be a process", async () => {
    expect(await readProcessPrivateMB(0, "win32")).toBeUndefined();
    expect(await readProcessPrivateMB(-3, "win32")).toBeUndefined();
  });

  it.if(process.platform === "win32")("reads this process from outside the same as from inside", async () => {
    const outside = await readProcessPrivateMB(process.pid);
    const inside = (await readNativeMemory()).privateMB;
    expect(outside).toBeGreaterThan(0);
    expect(inside).toBeGreaterThan(0);
    expect(Math.abs(outside! - inside!)).toBeLessThan(64);
  });

  it.if(process.platform === "win32")("never reads an exited process as over a limit", async () => {
    // While a handle to it is still open Windows answers 0 rather than failing; either way
    // a dead edge cannot look like one that needs replacing.
    const child = Bun.spawn([process.execPath, "-e", "0"]);
    await child.exited;
    const mb = await readProcessPrivateMB(child.pid);
    expect(mb === undefined || mb === 0).toBe(true);
    expect(edgeOverLimit(mb, 1)).toBe(false);
  });
});
