import { describe, expect, it } from "bun:test";
import {
  DESIGN_INSTRUCTIONS_MAX_BYTES, MAX_SKILL_MENTIONS, extractSkillMentions, normalizeDesignInstructions,
  resolveSkillMention, resolveSkillMentions, utf8ByteLength,
} from "../../../src/shared/design-skill-mentions.ts";
import { isKnownDesignSkill, needsDesignSkillSuggestion } from "../../../src/shared/design-skill-suggestion.ts";

describe("extractSkillMentions", () => {
  it("finds / and $ mentions that open a word, in order, without their sigil", () => {
    expect(extractSkillMentions("Use /ak:ui-ux-pro-max first, then $imagegen.\n(/devops/deploy)"))
      .toEqual(["ak:ui-ux-pro-max", "imagegen", "devops/deploy"]);
  });

  it("ignores paths, URLs, shell variables and prices that are not mentions", () => {
    expect(extractSkillMentions("Edit src/app.tsx, see https://example.com/pricing and $HOME or a/b")).toEqual([]);
    expect(extractSkillMentions("Plans at $29/mo or $9, and /2024 archives")).toEqual([]);
  });

  it("drops sentence punctuation after a name and deduplicates", () => {
    expect(extractSkillMentions("Try /brand. Then /brand: again, and /brand-kit-")).toEqual(["brand", "brand-kit"]);
  });

  it("stops at the mention cap", () => {
    const text = Array.from({ length: MAX_SKILL_MENTIONS + 5 }, (_, i) => `/skill-${i}`).join(" ");
    expect(extractSkillMentions(text)).toHaveLength(MAX_SKILL_MENTIONS);
  });
});

describe("resolveSkillMention", () => {
  const claude = [
    { name: "ak-engineer:ak-ui-ux-pro-max", aliases: ["ak:ui-ux-pro-max"] },
    { name: "ak-marketing:ak-ui-ux-pro-max", aliases: ["ak:ui-ux-pro-max"] },
    { name: "brand" },
  ];

  it("prefers the exact name, then an alias in discovery order", () => {
    expect(resolveSkillMention("brand", claude)?.name).toBe("brand");
    expect(resolveSkillMention("ak:ui-ux-pro-max", claude)?.name).toBe("ak-engineer:ak-ui-ux-pro-max");
  });

  it("falls back to the un-namespaced name so one text serves both runtimes", () => {
    expect(resolveSkillMention("ui-ux-pro-max", claude)?.name).toBe("ak-engineer:ak-ui-ux-pro-max");
    expect(resolveSkillMention("ak:ui-ux-pro-max", [{ name: "ui-ux-pro-max" }])?.name).toBe("ui-ux-pro-max");
  });

  it("answers null for a name nothing carries", () => {
    expect(resolveSkillMention("tmp", claude)).toBeNull();
    expect(resolveSkillMentions(["brand", "tmp"], claude)).toEqual({
      resolved: [{ mention: "brand", skill: { name: "brand" } }],
      unresolved: ["tmp"],
    });
  });
});

describe("normalizeDesignInstructions", () => {
  it("folds line endings and trims", () => {
    expect(normalizeDesignInstructions("  a\r\nb\rc  ")).toEqual({ ok: true, text: "a\nb\nc" });
  });

  it("refuses non-strings and NUL", () => {
    expect(normalizeDesignInstructions(42).ok).toBe(false);
    expect(normalizeDesignInstructions(undefined).ok).toBe(false);
    expect(normalizeDesignInstructions("a\u0000b").ok).toBe(false);
  });

  it("caps the UTF-8 size, not the character count", () => {
    expect(normalizeDesignInstructions("a".repeat(DESIGN_INSTRUCTIONS_MAX_BYTES)).ok).toBe(true);
    expect(normalizeDesignInstructions("a".repeat(DESIGN_INSTRUCTIONS_MAX_BYTES + 1)).ok).toBe(false);
    const vietnamese = "ệ".repeat(Math.floor(DESIGN_INSTRUCTIONS_MAX_BYTES / 3) + 1);
    expect(utf8ByteLength(vietnamese)).toBeGreaterThan(DESIGN_INSTRUCTIONS_MAX_BYTES);
    expect(normalizeDesignInstructions(vietnamese).ok).toBe(false);
  });
});

describe("needsDesignSkillSuggestion", () => {
  it("suggests only when nothing named resolves and no known design skill is installed anywhere", () => {
    expect(needsDesignSkillSuggestion("", [[{ name: "brand" }], []])).toBe(true);
    expect(needsDesignSkillSuggestion("Use /brand", [[{ name: "brand" }], []])).toBe(false);
    expect(needsDesignSkillSuggestion("", [[], [{ name: "ui-ux-pro-max" }]])).toBe(false);
    expect(needsDesignSkillSuggestion("", [[{ name: "ak-engineer:ak-x", aliases: ["ak:ui-ux-pro-max"] }]])).toBe(false);
    expect(needsDesignSkillSuggestion("Use /missing", [[{ name: "brand" }]])).toBe(true);
  });

  it("recognises the installed copies by name or alias", () => {
    expect(isKnownDesignSkill({ name: "ak-engineer:ak-ui-ux-pro-max" })).toBe(true);
    expect(isKnownDesignSkill({ name: "brand" })).toBe(false);
  });
});
