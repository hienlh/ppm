import { describe, expect, it } from "bun:test";
import { DEFAULT_QUERY_ROW_LIMIT, QUERY_ROW_LIMITS, queryRowLimit } from "../../../src/shared/db-query-script.ts";

describe("queryRowLimit", () => {
  it("keeps a limit the Query tab offers", () => {
    for (const limit of QUERY_ROW_LIMITS) expect(queryRowLimit(limit)).toBe(limit);
  });

  it("brings any other number within the limits, as a whole number of rows", () => {
    expect(queryRowLimit(1e9)).toBe(Math.max(...QUERY_ROW_LIMITS));
    expect(queryRowLimit(0)).toBe(1);
    expect(queryRowLimit(-5)).toBe(1);
    expect(queryRowLimit(250.9)).toBe(250);
  });

  it("falls back to the default for what is not a finite number", () => {
    for (const asked of [undefined, null, "500", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(queryRowLimit(asked)).toBe(DEFAULT_QUERY_ROW_LIMIT);
    }
  });
});
