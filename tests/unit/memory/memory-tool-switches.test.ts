import { describe, expect, it } from "bun:test";
import {
  isMemoryTool, MEMORY_FORGET_TOOL, MEMORY_READ_TOOL, MEMORY_SEARCH_TOOL, MEMORY_TOOLS, MEMORY_WRITE_TOOL,
} from "../../../src/shared/memory-tools.ts";
import {
  anyPpmToolOn, isPpmTool, patchPpmToolSwitches, PPM_TOOLS, ppmToolOn, TAB_TOOLS, type PpmTool,
} from "../../../src/shared/ppm-tools.ts";
import {
  answerFromSwitches, FEATURE_INTROS, featureIntroById, featureIntroOfTool, switchesForAnswer,
} from "../../../src/shared/feature-intros.ts";
import { SESSION_HISTORY_TOOLS } from "../../../src/shared/session-history-tools.ts";
import { SESSION_COLLAB_TOOLS } from "../../../src/shared/session-collab.ts";

const MEMORY_INTRO_ID = "ppm-memory-2026-11";
const memoryTools = MEMORY_TOOLS as readonly PpmTool[];
const memoryOn = (ai: Parameters<typeof ppmToolOn>[0]) => memoryTools.filter((tool) => ppmToolOn(ai, tool));

describe("memory tool names", () => {
  it("names the four memory tools", () => {
    expect([MEMORY_SEARCH_TOOL, MEMORY_READ_TOOL, MEMORY_WRITE_TOOL, MEMORY_FORGET_TOOL])
      .toEqual(["memory_search", "memory_read", "memory_write", "memory_forget"]);
    expect([...MEMORY_TOOLS]).toEqual(["memory_search", "memory_read", "memory_write", "memory_forget"]);
  });

  it("recognises a memory tool and nothing else", () => {
    for (const tool of MEMORY_TOOLS) expect(isMemoryTool(tool)).toBe(true);
    for (const name of ["search_sessions", "open_file", "mcp__ppm-tabs__memory_read", "memory", "", "__proto__"]) {
      expect(isMemoryTool(name)).toBe(false);
    }
  });

  it("serves them from the tab-tools server and counts them as PPM tools", () => {
    for (const tool of MEMORY_TOOLS) {
      expect(TAB_TOOLS as readonly string[]).toContain(tool);
      expect(PPM_TOOLS as readonly string[]).toContain(tool);
      expect(isPpmTool(tool)).toBe(true);
    }
  });
});

describe("memory tool switches", () => {
  it("keeps every memory tool off until the user decides", () => {
    expect(memoryOn({})).toEqual([]);
    expect(memoryOn({ tab_tools: true })).toEqual([]);
    expect(memoryOn({ ppm_tools: {} })).toEqual([]);
    expect(anyPpmToolOn({}, memoryTools)).toBe(false);
  });

  it("does not turn on because another introduced feature was answered", () => {
    const sessionsOn = Object.fromEntries([...SESSION_HISTORY_TOOLS, ...SESSION_COLLAB_TOOLS].map((t) => [t, true]));
    expect(memoryOn({ ppm_tools: sessionsOn })).toEqual([]);
  });

  it("turns all four on when the intro is answered on, and keeps them off when answered off", () => {
    const intro = featureIntroById(MEMORY_INTRO_ID)!;
    expect(intro).toBeDefined();
    expect(memoryOn({ ppm_tools: switchesForAnswer(intro, "on") })).toEqual([...memoryTools]);
    expect(memoryOn({ ppm_tools: switchesForAnswer(intro, "off") })).toEqual([]);
    expect(anyPpmToolOn({ ppm_tools: switchesForAnswer(intro, "on") }, memoryTools)).toBe(true);
  });

  it("lets an unset memory switch follow the set ones: on if any is on", () => {
    expect(memoryOn({ ppm_tools: { memory_search: true } })).toEqual([...memoryTools]);
    expect(memoryOn({ ppm_tools: { memory_search: false } })).toEqual([]);
    expect(memoryOn({ ppm_tools: { memory_search: false, memory_forget: true } }))
      .toEqual(["memory_read", "memory_write", "memory_forget"]);
  });

  it("takes a memory tool's own switch over the feature's answer", () => {
    const intro = featureIntroById(MEMORY_INTRO_ID)!;
    expect(memoryOn({ ppm_tools: { ...switchesForAnswer(intro, "on"), memory_write: false } }))
      .toEqual(["memory_search", "memory_read", "memory_forget"]);
  });

  it("saves one memory switch without flipping its siblings", () => {
    expect(patchPpmToolSwitches(undefined, { memory_write: true })).toEqual({
      memory_search: false, memory_read: false, memory_write: true, memory_forget: false,
    });
  });
});

describe("memory feature intro", () => {
  it("introduces memory through the tour with all four tools", () => {
    const intro = featureIntroById(MEMORY_INTRO_ID);
    expect(intro).toBeDefined();
    expect(intro!.title).toBe("One memory for every provider");
    expect([...intro!.tools]).toEqual([...MEMORY_TOOLS]);
    expect(intro!.body.length).toBeGreaterThan(0);
    expect(intro!.since).toBe("2026-11");
    for (const tool of MEMORY_TOOLS) expect(featureIntroOfTool(tool)?.id).toBe(MEMORY_INTRO_ID);
    expect(answerFromSwitches(undefined, intro!)).toBeNull();
  });

  it("uses an id no other feature has", () => {
    const ids = FEATURE_INTROS.map((intro) => intro.id);
    expect(ids.filter((id) => id === MEMORY_INTRO_ID)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts each tool in at most one introduced feature", () => {
    const tools = FEATURE_INTROS.flatMap((intro) => [...intro.tools]);
    expect(new Set(tools).size).toBe(tools.length);
  });
});
