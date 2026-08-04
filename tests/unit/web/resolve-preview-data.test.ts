import { describe, test, expect } from "bun:test";
import { resolvePreviewData, rowPk, type PreviewSource } from "../../../src/web/components/database/resolve-preview-data";

const ctx = (rows: Record<string, unknown>[]) => ({
  displayRows: rows,
  pkCol: "id",
  selectedTable: "orders",
  connectionId: 1,
});

const cellSource: PreviewSource = { kind: "cell", rowIdx: 0, pk: "7", colName: "payload" };

describe("resolvePreviewData", () => {
  test("cell content reflects reloaded row data", () => {
    const before = resolvePreviewData(cellSource, ctx([{ id: 7, payload: '{"status":"pending"}' }]));
    const after = resolvePreviewData(cellSource, ctx([{ id: 7, payload: '{"status":"paid"}' }]));
    expect(before?.content).toBe('{"status":"pending"}');
    expect(after?.content).toBe('{"status":"paid"}');
    expect(after?.title).toBe(before?.title);
    expect(after?.language).toBe("json");
  });

  test("resolves by pk when reload reorders rows", () => {
    const rows = [{ id: 9, payload: "nine" }, { id: 7, payload: "seven" }];
    expect(resolvePreviewData(cellSource, ctx(rows))?.content).toBe("seven");
  });

  test("falls back to row index when no pk available", () => {
    const source: PreviewSource = { kind: "cell", rowIdx: 1, pk: null, colName: "payload" };
    const got = resolvePreviewData(source, { displayRows: [{ payload: "a" }, { payload: "b" }], pkCol: null });
    expect(got?.content).toBe("b");
    expect(got?.title).toBe("payload #1");
  });

  test("row preview serializes the current row", () => {
    const source: PreviewSource = { kind: "row", rowIdx: 0, pk: "7" };
    const got = resolvePreviewData(source, ctx([{ id: 7, payload: "x" }]));
    expect(JSON.parse(got!.content)).toEqual({ id: 7, payload: "x" });
    expect(got?.title).toBe("Row #7 — orders");
    expect(got?.viewerKey).toBe("1:orders:row:7");
  });

  test("returns null when the row disappeared after reload", () => {
    expect(resolvePreviewData(cellSource, ctx([]))).toBeNull();
    expect(resolvePreviewData(null, ctx([{ id: 7 }]))).toBeNull();
  });

  test("language re-detected when cell content type changes", () => {
    const asJson = resolvePreviewData(cellSource, ctx([{ id: 7, payload: '{"a":1}' }]));
    const asText = resolvePreviewData(cellSource, ctx([{ id: 7, payload: "plain text" }]));
    expect(asJson?.language).toBe("json");
    expect(asText?.language).toBe("plaintext");
  });
});

describe("rowPk", () => {
  test("stringifies pk, null when missing or no pk column", () => {
    expect(rowPk({ id: 7 }, "id")).toBe("7");
    expect(rowPk({ id: null }, "id")).toBeNull();
    expect(rowPk({ id: 7 }, null)).toBeNull();
  });
});
