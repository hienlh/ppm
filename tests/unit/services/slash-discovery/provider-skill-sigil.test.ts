import { describe, it, expect } from "bun:test";
import { applySkillSigil } from "../../../../src/services/slash-discovery/provider-skill-sigil.ts";

const SKILLS = new Set(["imagegen", "openai-docs", "skill-creator"]);

describe("applySkillSigil", () => {
  it("swaps the slash for the runtime's sigil on a known skill", () => {
    expect(applySkillSigil("/imagegen", SKILLS, "$")).toBe("$imagegen");
  });

  it("keeps everything after the name untouched", () => {
    expect(applySkillSigil("/imagegen a red cube, save to assets/", SKILLS, "$"))
      .toBe("$imagegen a red cube, save to assets/");
  });

  it("handles a hyphenated skill name", () => {
    expect(applySkillSigil("/openai-docs what models exist", SKILLS, "$"))
      .toBe("$openai-docs what models exist");
  });

  it("leaves a command the runtime does not own alone", () => {
    // PPM built-ins and Claude skills must keep their slash — the caller relies
    // on this to keep `/clear` interceptable from a codex tab.
    expect(applySkillSigil("/clear", SKILLS, "$")).toBe("/clear");
    expect(applySkillSigil("/ak:debug something", SKILLS, "$")).toBe("/ak:debug something");
  });

  it("does not match on a prefix of a skill name", () => {
    expect(applySkillSigil("/image", SKILLS, "$")).toBe("/image");
    expect(applySkillSigil("/imagegen2", SKILLS, "$")).toBe("/imagegen2");
  });

  it("leaves a bare slash and slash-space alone", () => {
    expect(applySkillSigil("/", SKILLS, "$")).toBe("/");
    expect(applySkillSigil("/ imagegen", SKILLS, "$")).toBe("/ imagegen");
  });

  it("leaves text that does not start with a slash alone", () => {
    expect(applySkillSigil("please run /imagegen", SKILLS, "$")).toBe("please run /imagegen");
    expect(applySkillSigil("$imagegen already", SKILLS, "$")).toBe("$imagegen already");
  });

  it("is a no-op when the runtime reported no skills", () => {
    expect(applySkillSigil("/imagegen", new Set(), "$")).toBe("/imagegen");
  });
});
