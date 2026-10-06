/**
 * Reading `ppm.log` back by level — what `ppm logs --level`, the bug report and the public
 * `/api/logs/recent` tail rely on. A multi-line record (a stack trace, a dumped tool output)
 * must travel with its first line, or a DEBUG record leaks out through its continuation lines.
 */
import { describe, it, expect } from "bun:test";
import { filterLogLines, createLogLineFilter, parseLogLevel, logLevelRank } from "../../../src/shared/log-levels.ts";

const LOG = [
  "  …end of a record whose first line the tail cut off",
  "[2026-10-06T01:00:00.000Z] [DEBUG] [chat] tool_result: output=line one",
  "line two of the tool output",
  "[2026-10-06T01:00:01.000Z] [INFO] [http] POST /api/projects 200 3ms",
  "[2026-10-06T01:00:02.000Z] [ERROR] [process] Uncaught exception: Error: boom",
  "    at handler (src/x.ts:1:1)",
  "[2026-10-06T01:00:03.000Z] [WARN] [ws] Refused /ws/global: unauthorized",
];

describe("filterLogLines", () => {
  it("keeps a record's continuation lines with it, and drops a DEBUG record whole", () => {
    expect(filterLogLines(LOG, "info")).toEqual(LOG.slice(3));
  });

  it("filters from the threshold up", () => {
    expect(filterLogLines(LOG, "error")).toEqual([LOG[4], LOG[5]]);
    expect(filterLogLines(LOG, "debug")).toEqual(LOG.slice(1));
  });

  it("drops lines before the first record, whose level is unknown", () => {
    expect(filterLogLines(LOG, "debug")[0]).toBe(LOG[1]);
  });

  it("carries the decision across calls, for a followed log", () => {
    const keep = createLogLineFilter("warn");
    expect(keep(LOG[4]!)).toBe(true);
    expect(keep(LOG[5]!)).toBe(true);
    expect(keep(LOG[1]!)).toBe(false);
    expect(keep(LOG[2]!)).toBe(false);
  });
});

describe("levels", () => {
  it("parses and ranks", () => {
    expect(parseLogLevel("Error")).toBe("error");
    expect(parseLogLevel("trace")).toBeNull();
    expect(logLevelRank("debug")).toBeLessThan(logLevelRank("info"));
    expect(logLevelRank("error")).toBeLessThan(logLevelRank("fatal"));
  });
});
