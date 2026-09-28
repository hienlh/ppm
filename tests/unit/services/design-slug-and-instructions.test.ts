import { describe, expect, it } from "bun:test";
import { DESIGN_SLUG_RE, isValidDesignSlug, slugFromTitle } from "../../../src/services/design/design-slug.ts";
import { buildDesignInstructions } from "../../../src/services/design/design-instructions.ts";
import { DESIGN_CDN_HOSTS } from "../../../src/shared/design-cdn-hosts.ts";
import { parseTweaks } from "../../../src/shared/design-tweaks.ts";

describe("isValidDesignSlug", () => {
  it("accepts a single lowercase path segment", () => {
    for (const slug of ["a", "landing", "landing-page-v2", "0day", "a".repeat(63)]) {
      expect(isValidDesignSlug(slug)).toBe(true);
    }
  });

  it("rejects anything that could leave designs/ or is not a slug", () => {
    for (const slug of [
      "", "..", ".", "../etc", "a/b", "a\\b", "/abs", "C:", "Landing", "-lead", "has space",
      "dot.ted", "a".repeat(64), "ünicode",
    ]) {
      expect(isValidDesignSlug(slug)).toBe(false);
    }
    expect(isValidDesignSlug(undefined)).toBe(false);
    expect(isValidDesignSlug(42)).toBe(false);
    expect(DESIGN_SLUG_RE.test("ok-slug")).toBe(true);
  });
});

describe("slugFromTitle", () => {
  it("folds a title into a slug", () => {
    expect(slugFromTitle("Landing page — v2")).toBe("landing-page-v2");
    expect(slugFromTitle("  Trang chủ Đẹp  ")).toBe("trang-chu-dep");
    expect(slugFromTitle("Café résumé")).toBe("cafe-resume");
  });

  it("answers empty when nothing usable remains", () => {
    expect(slugFromTitle("")).toBe("");
    expect(slugFromTitle("!!! ---")).toBe("");
    expect(slugFromTitle("日本語")).toBe("");
  });

  it("stays within the length limit without a trailing hyphen", () => {
    const slug = slugFromTitle(`${"a".repeat(62)} b`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
    expect(isValidDesignSlug(slug)).toBe(true);
  });
});

describe("buildDesignInstructions", () => {
  const text = buildDesignInstructions("smoke");

  it("names the design's own folder and entry", () => {
    expect(text).toContain("designs/smoke/");
    expect(text).toContain("designs/smoke/index.html");
    expect(text).toContain("designs/smoke/design.json");
  });

  it("lists every allowed CDN host", () => {
    expect(DESIGN_CDN_HOSTS).toHaveLength(5);
    for (const host of DESIGN_CDN_HOSTS) expect(text).toContain(`https://${host}`);
  });

  it("covers the design system, the canvas's own data and the slide format", () => {
    expect(text).toContain("designs/DESIGN.md");
    expect(text).toContain("../tokens.css");
    expect(text).toContain(".design/");
    expect(text).toMatch(/Never read, search, list or write anything under a `\.design\/`/);
    expect(text).toContain('<section class="slide">');
    expect(text).toContain("1280x720");
    expect(text).toContain(":root");
    expect(text).toContain("tweaks");
  });

  it("embeds a tweaks example the schema parser accepts with zero errors", () => {
    const fenced = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(fenced).not.toBeNull();
    const example = JSON.parse(fenced![1]!);
    const { tweaks, errors } = parseTweaks(example.tweaks);
    expect(errors).toEqual([]);
    expect(tweaks.map((t) => t.type).sort()).toEqual(["color", "range", "select"]);
    expect(text).toMatch(/Never put\s+tweak variables in `\.\.\/tokens\.css`/);
  });

  it("refuses to build from an invalid slug rather than escaping it", () => {
    expect(() => buildDesignInstructions("../x")).toThrow();
    expect(() => buildDesignInstructions("")).toThrow();
  });

  it("asks for design_check only when the session has the tool, and always explains the automatic check", () => {
    const withTool = buildDesignInstructions("smoke", { checkTool: true });
    expect(withTool).toContain("call the `design_check` tool");
    expect(withTool).toContain("[Canvas check]");
    expect(text).not.toContain("`design_check` tool");
    expect(text).toContain("[Canvas check]");
  });
});
