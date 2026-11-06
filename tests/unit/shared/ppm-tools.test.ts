import { describe, expect, it } from "bun:test";
import { DB_TOOLS } from "../../../src/shared/db-ai-tools.ts";
import { anyPpmToolOn, isPpmTool, PPM_TOOLS, ppmToolOn, SESSION_TOOLS, TAB_TOOLS, TERMINAL_TOOLS } from "../../../src/shared/ppm-tools.ts";
import { SESSION_HISTORY_TOOLS } from "../../../src/shared/session-history-tools.ts";

const onOf = (ai: Parameters<typeof ppmToolOn>[0]) => PPM_TOOLS.filter((tool) => ppmToolOn(ai, tool));
const ALL_TAB_TOOLS_OFF = Object.fromEntries(TAB_TOOLS.map((tool) => [tool, false]));

describe("PPM tool switches", () => {
  it("defaults open_file and open_preview to the older single switch, and every other tool to on", () => {
    const others = ["open_url", ...TERMINAL_TOOLS, ...SESSION_HISTORY_TOOLS, ...DB_TOOLS, ...SESSION_TOOLS];
    expect(onOf({})).toEqual(others);
    expect(onOf({ tab_tools: false })).toEqual(others);
    expect(onOf({ tab_tools: true })).toEqual([...PPM_TOOLS]);
  });

  it("takes a tool's own switch over its default, one tool at a time", () => {
    expect(onOf({ tab_tools: true, ppm_tools: { open_preview: false, read_terminal: false, db_execute: false } }))
      .toEqual(["open_file", "open_url", "run_in_terminal", ...SESSION_HISTORY_TOOLS, "db_query", "open_query", ...SESSION_TOOLS]);
    expect(onOf({ ppm_tools: { ...ALL_TAB_TOOLS_OFF, open_file: true } })).toEqual(["open_file", ...DB_TOOLS, ...SESSION_TOOLS]);
  });

  it("needs a tool server only while one of its tools is on", () => {
    expect(anyPpmToolOn({}, TAB_TOOLS)).toBe(true);
    expect(anyPpmToolOn({ ppm_tools: ALL_TAB_TOOLS_OFF }, TAB_TOOLS)).toBe(false);
    expect(anyPpmToolOn({ ppm_tools: { ...ALL_TAB_TOOLS_OFF, open_preview: true } }, TAB_TOOLS)).toBe(true);
    expect(anyPpmToolOn({ ppm_tools: { db_query: false, open_query: false, db_execute: false } }, DB_TOOLS)).toBe(false);
    expect(anyPpmToolOn({ ppm_tools: { db_query: false, open_query: false } }, DB_TOOLS)).toBe(true);
    expect(anyPpmToolOn({}, SESSION_TOOLS)).toBe(true);
    expect(anyPpmToolOn({ ppm_tools: { create_session: false, send_to_session: false, session_status: false } }, SESSION_TOOLS)).toBe(false);
  });

  it("knows PPM's own tool names and no others", () => {
    expect(PPM_TOOLS.every(isPpmTool)).toBe(true);
    for (const name of ["Bash", "mcp__ppm-db__db_query", "__proto__", "constructor", "", 1, null]) expect(isPpmTool(name)).toBe(false);
  });
});
