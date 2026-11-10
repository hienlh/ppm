import { describe, expect, it } from "bun:test";
import { DB_TOOLS } from "../../../src/shared/db-ai-tools.ts";
import {
  anyPpmToolOn, isPpmTool, patchPpmToolSwitches, PPM_TOOLS, ppmToolOn, SESSION_TOOLS, SPEC_MODE_TOOLS, TAB_TOOLS, TERMINAL_TOOLS, type PpmTool,
} from "../../../src/shared/ppm-tools.ts";
import { SESSION_HISTORY_TOOLS } from "../../../src/shared/session-history-tools.ts";

const onOf = (ai: Parameters<typeof ppmToolOn>[0]) => PPM_TOOLS.filter((tool) => ppmToolOn(ai, tool));
const ALL_TAB_TOOLS_OFF = Object.fromEntries(TAB_TOOLS.map((tool) => [tool, false]));
const SESSION_TOOLS_AND_HISTORY: readonly PpmTool[] = [...SESSION_HISTORY_TOOLS, ...SESSION_TOOLS];
const ALL_SESSION_ON = Object.fromEntries(SESSION_TOOLS_AND_HISTORY.map((tool) => [tool, true]));

describe("PPM tool switches", () => {
  // The six session tools are introduced by the tour and stay off until the user answers; before
  // that they defaulted to on like the other tools, which is what these expectations used to say.
  it("defaults open_file and open_preview to the older single switch, the introduced session tools to off, and every other tool to on", () => {
    const others = ["open_url", ...TERMINAL_TOOLS, ...DB_TOOLS, ...SPEC_MODE_TOOLS];
    expect(onOf({})).toEqual(others);
    expect(onOf({ tab_tools: false })).toEqual(others);
    expect(onOf({ tab_tools: true })).toEqual(["open_file", "open_preview", ...others]);
  });

  it("takes a tool's own switch over its default, one tool at a time", () => {
    expect(onOf({ tab_tools: true, ppm_tools: { open_preview: false, read_terminal: false, db_execute: false, ...ALL_SESSION_ON } }))
      .toEqual(["open_file", "open_url", "run_in_terminal", ...SESSION_HISTORY_TOOLS, "db_query", "open_query", ...SESSION_TOOLS, ...SPEC_MODE_TOOLS]);
    expect(onOf({ ppm_tools: { ...ALL_TAB_TOOLS_OFF, open_file: true } })).toEqual(["open_file", ...DB_TOOLS, ...SPEC_MODE_TOOLS]);
  });

  it("lets an introduced tool's unset switch follow the feature's set ones: on if any is on", () => {
    expect(onOf({ ppm_tools: { search_sessions: true } })).toContain("create_session");
    expect(onOf({ ppm_tools: { search_sessions: false } }).filter((t) => SESSION_TOOLS_AND_HISTORY.includes(t))).toEqual([]);
    expect(onOf({ ppm_tools: { search_sessions: false, session_status: true } })).toEqual(
      ["open_url", ...TERMINAL_TOOLS, "list_session_turns", "read_session_turns", ...DB_TOOLS, ...SESSION_TOOLS, ...SPEC_MODE_TOOLS]);
  });

  it("saves one introduced switch without flipping its siblings", () => {
    // Before an answer every sibling shows off, so it is written off.
    expect(patchPpmToolSwitches(undefined, { create_session: true })).toEqual({
      search_sessions: false, list_session_turns: false, read_session_turns: false,
      create_session: true, send_to_session: false, session_status: false,
    });
    // After "Turn on" they are all set already, and only the patched one moves.
    expect(patchPpmToolSwitches({ ...ALL_SESSION_ON, db_query: false }, { session_status: false }))
      .toEqual({ ...ALL_SESSION_ON, db_query: false, session_status: false });
    // A tool outside any introduced feature writes nothing else.
    expect(patchPpmToolSwitches({ open_url: true }, { db_execute: false })).toEqual({ open_url: true, db_execute: false });
  });

  it("needs a tool server only while one of its tools is on", () => {
    expect(anyPpmToolOn({}, TAB_TOOLS)).toBe(true);
    expect(anyPpmToolOn({ ppm_tools: ALL_TAB_TOOLS_OFF }, TAB_TOOLS)).toBe(false);
    expect(anyPpmToolOn({ ppm_tools: { ...ALL_TAB_TOOLS_OFF, open_preview: true } }, TAB_TOOLS)).toBe(true);
    expect(anyPpmToolOn({ ppm_tools: { db_query: false, open_query: false, db_execute: false } }, DB_TOOLS)).toBe(false);
    expect(anyPpmToolOn({ ppm_tools: { db_query: false, open_query: false } }, DB_TOOLS)).toBe(true);
    expect(anyPpmToolOn({}, SESSION_TOOLS)).toBe(false);
    expect(anyPpmToolOn({ ppm_tools: ALL_SESSION_ON }, SESSION_TOOLS)).toBe(true);
    expect(anyPpmToolOn({ ppm_tools: { create_session: false, send_to_session: false, session_status: false } }, SESSION_TOOLS)).toBe(false);
  });

  it("knows PPM's own tool names and no others", () => {
    expect(PPM_TOOLS.every(isPpmTool)).toBe(true);
    for (const name of ["Bash", "mcp__ppm-db__db_query", "__proto__", "constructor", "", 1, null]) expect(isPpmTool(name)).toBe(false);
  });
});
