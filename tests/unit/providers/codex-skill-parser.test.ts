import { describe, it, expect } from "bun:test";
import { parseSkillList } from "../../../src/providers/codex-app-server/codex-skill-parser.ts";

/** Shape of a real `skills/list` reply, trimmed to the fields that matter. */
const RESPONSE = {
  data: [{
    cwd: "C:\\Users\\PC\\ppm",
    skills: [
      {
        name: "imagegen",
        description: "Generate or edit raster images…",
        interface: {
          displayName: "Image Gen",
          shortDescription: "Generate or edit images for websites, games, and more",
          iconSmall: "C:\\Users\\PC\\.codex\\skills\\.system\\imagegen\\assets\\imagegen-small.svg",
          iconLarge: "C:\\Users\\PC\\.codex\\skills\\.system\\imagegen\\assets\\imagegen.png",
          defaultPrompt: "Use $imagegen to make or edit an image for this project.",
        },
        path: "C:\\Users\\PC\\.codex\\skills\\.system\\imagegen\\SKILL.md",
        scope: "system",
        enabled: true,
        pluginId: null,
      },
      { name: "openai-docs", scope: "system", enabled: true },
    ],
  }],
};

describe("parseSkillList", () => {
  it("flattens the per-cwd groups into one list", () => {
    const out = parseSkillList(RESPONSE);
    expect(out.map((s) => s.name)).toEqual(["imagegen", "openai-docs"]);
  });

  it("keeps the interface block used by the picker", () => {
    const [imagegen] = parseSkillList(RESPONSE);
    expect(imagegen!.interface).toEqual({
      displayName: "Image Gen",
      shortDescription: "Generate or edit images for websites, games, and more",
      iconSmall: "C:\\Users\\PC\\.codex\\skills\\.system\\imagegen\\assets\\imagegen-small.svg",
      iconLarge: "C:\\Users\\PC\\.codex\\skills\\.system\\imagegen\\assets\\imagegen.png",
      defaultPrompt: "Use $imagegen to make or edit an image for this project.",
    });
  });

  it("leaves interface undefined for a skill that has none", () => {
    const [, docs] = parseSkillList(RESPONSE);
    expect(docs!.interface).toBeUndefined();
  });

  it("drops disabled skills — codex would not run them", () => {
    const res = { data: [{ skills: [{ name: "on", enabled: true }, { name: "off", enabled: false }] }] };
    expect(parseSkillList(res).map((s) => s.name)).toEqual(["on"]);
  });

  it("treats a missing enabled flag as enabled", () => {
    expect(parseSkillList({ data: [{ skills: [{ name: "x" }] }] }).map((s) => s.name)).toEqual(["x"]);
  });

  it("keeps the first of two same-named skills across groups", () => {
    const res = {
      data: [
        { cwd: "/a", skills: [{ name: "dup", description: "project wins" }] },
        { cwd: "/b", skills: [{ name: "dup", description: "user loses" }] },
      ],
    };
    const out = parseSkillList(res);
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toBe("project wins");
  });

  it("skips nameless and malformed entries", () => {
    const res = { data: [{ skills: [{ name: "" }, { description: "no name" }, null, 7, { name: "ok" }] }] };
    expect(parseSkillList(res).map((s) => s.name)).toEqual(["ok"]);
  });

  it("returns [] for malformed or empty input", () => {
    expect(parseSkillList(undefined)).toEqual([]);
    expect(parseSkillList({})).toEqual([]);
    expect(parseSkillList({ data: "nope" })).toEqual([]);
    expect(parseSkillList({ data: [{ skills: "nope" }] })).toEqual([]);
  });
});
