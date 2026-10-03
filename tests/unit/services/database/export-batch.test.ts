import { describe, expect, it } from "bun:test";
import { RowBatcher, nextFetchCount, rowBytes, valueBytes } from "../../../../src/services/database/export-batch.ts";

describe("valueBytes", () => {
  it("counts two bytes a character, one a byte, a word for anything else", () => {
    expect(valueBytes("abc")).toBe(6);
    expect(valueBytes(new Uint8Array(10))).toBe(10);
    expect(valueBytes(Buffer.alloc(7))).toBe(7);
    expect(valueBytes(42)).toBe(8);
    expect(valueBytes(42n)).toBe(8);
    expect(valueBytes(new Date())).toBe(8);
    expect(valueBytes(null)).toBe(1);
    expect(valueBytes(true)).toBe(1);
  });

  it("walks into lists and documents", () => {
    expect(valueBytes(["ab", 1])).toBe(8 + 4 + 8);
    expect(valueBytes({ ab: "cd", n: [1] })).toBe(8 + (4 + 4) + (2 + 8 + 8));
  });

  it("stops walking a document past a depth, so a deep one cannot run away", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(valueBytes(deep)).toBe(32 * 8 + 8);
  });

  it("adds a row's values up", () => {
    expect(rowBytes(["ab", new Uint8Array(3), null])).toBe(4 + 3 + 1);
  });
});

describe("RowBatcher", () => {
  it("ends a batch at its rows", () => {
    const batcher = new RowBatcher({ rows: 2, bytes: 1_000_000 });
    expect(batcher.add([1])).toBeNull();
    expect(batcher.add([2])).toEqual([[1], [2]]);
    expect(batcher.add([3])).toBeNull();
    expect(batcher.take()).toEqual([[3]]);
    expect(batcher.take()).toEqual([]);
  });

  it("ends a batch at its bytes, on the row that reaches them", () => {
    const batcher = new RowBatcher({ rows: 1000, bytes: 10 });
    expect(batcher.add(["abc"])).toBeNull();
    expect(batcher.add(["de"])).toEqual([["abc"], ["de"]]);
    // One row wider than the whole budget is a batch of its own.
    expect(batcher.add(["x".repeat(20)])).toEqual([["x".repeat(20)]]);
  });
});

describe("nextFetchCount", () => {
  const limits = { rows: 1000, bytes: 8_000 };

  it("doubles while the rows are narrow, up to the most rows a batch holds", () => {
    expect(nextFetchCount(1, 10, limits)).toBe(2);
    expect(nextFetchCount(512, 2, limits)).toBe(1000);
    expect(nextFetchCount(1000, 2, limits)).toBe(1000);
  });

  it("asks for as many rows as wide as the widest fit in the bytes", () => {
    expect(nextFetchCount(1000, 100, limits)).toBe(80);
    expect(nextFetchCount(1000, 3_000, limits)).toBe(2);
    expect(nextFetchCount(1000, 50_000, limits)).toBe(1);
  });

  it("asks for one row at least, also when nothing was measured", () => {
    expect(nextFetchCount(1, 0, limits)).toBe(2);
    expect(nextFetchCount(0, 0, limits)).toBe(1);
  });
});
