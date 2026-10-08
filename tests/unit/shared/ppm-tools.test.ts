import { describe, expect, it } from "bun:test";
import { DB_TOOLS } from "../../../src/shared/db-ai-tools.ts";
import { anyPpmToolOn, isPpmTool, PPM_TOOLS, ppmToolOn, TAB_TOOLS } from "../../../src/shared/ppm-tools.ts";

const onOf = (ai: Parameters<typeof ppmToolOn>[0]) => PPM_TOOLS.filter((tool) => ppmToolOn(ai, tool));

describe("PPM tool switches", () => {
  it("defaults the tab tools to the older single switch, and the database tools to on", () => {
    expect(onOf({})).toEqual([...DB_TOOLS]);
    expect(onOf({ tab_tools: false })).toEqual([...DB_TOOLS]);
    expect(onOf({ tab_tools: true })).toEqual([...PPM_TOOLS]);
  });

  it("takes a tool's own switch over its default, one tool at a time", () => {
    expect(onOf({ tab_tools: true, ppm_tools: { open_preview: false, db_execute: false } })).toEqual(["open_file", "db_query", "open_query"]);
    expect(onOf({ ppm_tools: { open_file: true } })).toEqual(["open_file", ...DB_TOOLS]);
  });

  it("needs a tool server only while one of its tools is on", () => {
    expect(anyPpmToolOn({}, TAB_TOOLS)).toBe(false);
    expect(anyPpmToolOn({ ppm_tools: { open_preview: true } }, TAB_TOOLS)).toBe(true);
    expect(anyPpmToolOn({ ppm_tools: { db_query: false, open_query: false, db_execute: false } }, DB_TOOLS)).toBe(false);
    expect(anyPpmToolOn({ ppm_tools: { db_query: false, open_query: false } }, DB_TOOLS)).toBe(true);
  });

  it("knows PPM's own tool names and no others", () => {
    expect(PPM_TOOLS.every(isPpmTool)).toBe(true);
    for (const name of ["Bash", "mcp__ppm-db__db_query", "__proto__", "constructor", "", 1, null]) expect(isPpmTool(name)).toBe(false);
  });
});
