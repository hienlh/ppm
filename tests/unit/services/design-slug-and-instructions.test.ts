import { describe, expect, it } from "bun:test";
import { DESIGN_SLUG_RE, isValidDesignSlug, slugFromTitle } from "../../../src/services/design/design-slug.ts";
import { buildDesignInstructions, MAX_CLARIFYING_QUESTIONS } from "../../../src/services/design/design-instructions.ts";
import { MAX_DESIGN_VARIANTS, parseDesignVariants } from "../../../src/shared/design-variants.ts";
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

const DEFAULT_SYSTEM = { id: "default", label: "Default", root: ".", platform: "web" as const };

describe("buildDesignInstructions", () => {
  const text = buildDesignInstructions("smoke", DEFAULT_SYSTEM);

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

  it("asks at most three questions before the first build, including how many variants, and never for edits", () => {
    const section = text.slice(text.indexOf("## Before the first build"), text.indexOf("## Variants"));
    expect(section).toContain("for the first time");
    expect(section).toContain(`at most ${MAX_CLARIFYING_QUESTIONS} short questions`);
    expect(MAX_CLARIFYING_QUESTIONS).toBe(3);
    expect(section).toContain("how many variants they want (1 to 5, default 1)");
    expect(section).toContain("`AskUserQuestion` tool when you have it");
    expect(section).toContain("one plain chat message");
    expect(section).toMatch(/Do not ask about edits or follow-ups/);
    expect(section).toMatch(/just build it\. Then build straight\s+away and state the assumptions/);
    for (const topic of ["purpose", "who it is", "main content", "visual style", "slide deck"]) expect(section).toContain(topic);
  });

  it("describes variants as up to five flat files listed in design.json, variant 1 being the entry", () => {
    const section = text.slice(text.indexOf("## Variants"), text.indexOf("## Assets and network"));
    expect(MAX_DESIGN_VARIANTS).toBe(5);
    expect(section).toContain("up to 5 variants");
    expect(section).toContain("never more than 5");
    expect(section).toContain("Variant 1 is the entry page `designs/smoke/index.html`");
    expect(section).toContain("`variant-2.html` to\n  `variant-N.html` in the same folder, never in a subfolder");
    const example = /`"variants": (\[.*?\])`/.exec(section);
    expect(example).not.toBeNull();
    const parsed = parseDesignVariants(JSON.parse(example![1]!), "index.html");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.variants.map((v) => v.file)).toEqual(["index.html", "variant-2.html"]);
    expect(section).toContain("Keep `kind`");
    expect(text).toContain("every check measures the one on the user's\n  screen");
  });

  it("refuses to build from an invalid slug rather than escaping it", () => {
    expect(() => buildDesignInstructions("../x", DEFAULT_SYSTEM)).toThrow();
    expect(() => buildDesignInstructions("", DEFAULT_SYSTEM)).toThrow();
  });

  it("says the agent may read the app's source, and never mentions changing it", () => {
    expect(text).toMatch(/though you may read it/);
    expect(text).not.toMatch(/Use this variant/);
  });

  it("covers the kit: link it, use its classes and icons, read the component map, and add a style block only for something new", () => {
    const section = text.slice(text.indexOf("## The design system"), text.indexOf("## The manifest"));
    expect(section).toContain('href="../systems/default/kit/app.css"');
    expect(section).toContain("../systems/default/kit/icons/<name>.svg");
    expect(section).toMatch(/component map/);
    expect(section).toMatch(/do not invent app chrome/);
    expect(section).toMatch(/genuinely new the kit has no\s+classes for/);
    expect(text).toContain("`../tokens.css` and\n  `../systems/default/…`");
  });

  it("points a non-default app at its own systems folder, root and platform", () => {
    const mobile = buildDesignInstructions("smoke", { id: "payroll", label: "Payroll", root: "payroll-fe", platform: "mobile" });
    const section = mobile.slice(mobile.indexOf("## The design system"), mobile.indexOf("## The manifest"));
    expect(section).toContain("designs/systems/payroll/DESIGN.md");
    expect(section).toContain('href="../systems/payroll/tokens.css"');
    expect(section).toContain('href="../systems/payroll/kit/app.css"');
    expect(section).toContain("payroll-fe");
    expect(section).toMatch(/mobile \(React Native/);
  });

  it("asks the agent to compare an attached screenshot with its own check and fix differences", () => {
    const section = text.slice(text.indexOf("## The design system"), text.indexOf("## The manifest"));
    expect(section).toMatch(/attached a screenshot of the real app, treat it as the target/);
    expect(section).toMatch(/fix visible\s+differences/);
  });

  it("says keeping or dropping a variant is done in files, by name, and never calls it 'Use this variant'", () => {
    const section = text.slice(text.indexOf("## Variants"), text.indexOf("## Assets and network"));
    expect(section).not.toMatch(/Use this variant/);
    expect(section).toMatch(/says which variant to keep, make it `index\.html`/);
    expect(section).toMatch(/say to drop one instead, delete just that variant's files/);
    expect(section).toMatch(/recoverable from Version history/);
  });

  it("asks for design_check only when the session has the tool, and always explains the automatic check", () => {
    const withTool = buildDesignInstructions("smoke", DEFAULT_SYSTEM, { checkTool: true });
    expect(withTool).toContain("call the `design_check` tool");
    expect(withTool).toContain("[Canvas check]");
    expect(text).not.toContain("`design_check` tool");
    expect(text).toContain("[Canvas check]");
  });
});
