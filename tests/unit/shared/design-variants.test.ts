import { describe, expect, it } from "bun:test";
import {
  MAX_DESIGN_VARIANTS, MAX_VARIANT_LABEL, designVariantsOf, isVariantFileName, parseDesignVariants, variantDisplayName,
} from "../../../src/shared/design-variants.ts";

const files = (value: unknown, entry = "index.html") => parseDesignVariants(value, entry).variants.map((v) => v.file);

describe("design variants", () => {
  it("treats a missing list as the entry alone, silently", () => {
    expect(parseDesignVariants(undefined, "index.html")).toEqual({ variants: [{ file: "index.html", label: "" }], warnings: [] });
    expect(parseDesignVariants(null, "index.html").warnings).toEqual([]);
  });

  it("keeps a valid list in order with its labels", () => {
    const parsed = parseDesignVariants([
      { file: "index.html", label: "Calm" }, { file: "variant-2.html", label: "  Bold\n  and loud " }, { file: "variant-3.htm" },
    ], "index.html");
    expect(parsed.warnings).toEqual([]);
    expect(parsed.variants).toEqual([
      { file: "index.html", label: "Calm" }, { file: "variant-2.html", label: "Bold and loud" }, { file: "variant-3.htm", label: "" },
    ]);
  });

  it("drops anything that is not a plain HTML file at the top of the folder, with a warning each", () => {
    const bad = ["../x.html", "sub/page.html", ".design/x.html", ".hidden.html", "notes.md", "a\\b.html", "", 42, null];
    const parsed = parseDesignVariants([{ file: "index.html" }, ...bad.map((file) => ({ file })), "variant-2.html", { file: "ok.html" }], "index.html");
    expect(parsed.variants.map((v) => v.file)).toEqual(["index.html", "ok.html"]);
    expect(parsed.warnings).toHaveLength(bad.length + 1);
    for (const name of ["sub/page.html", "../x.html"]) expect(isVariantFileName(name)).toBe(false);
    expect(isVariantFileName("variant-2.html")).toBe(true);
  });

  it("skips a file listed twice, case-insensitively", () => {
    const parsed = parseDesignVariants([{ file: "index.html" }, { file: "v2.html" }, { file: "V2.html" }], "index.html");
    expect(parsed.variants.map((v) => v.file)).toEqual(["index.html", "v2.html"]);
    expect(parsed.warnings[0]).toContain("listed twice");
  });

  it("always puts the entry first, moving or adding it", () => {
    const moved = parseDesignVariants([{ file: "b.html" }, { file: "index.html", label: "Main" }], "index.html");
    expect(moved.variants).toEqual([{ file: "index.html", label: "Main" }, { file: "b.html", label: "" }]);
    expect(moved.warnings[0]).toContain("moved in front");
    const added = parseDesignVariants([{ file: "b.html" }], "index.html");
    expect(added.variants.map((v) => v.file)).toEqual(["index.html", "b.html"]);
    expect(added.warnings[0]).toContain("added in front");
    expect(parseDesignVariants([{ file: "INDEX.html" }], "index.html").variants).toEqual([{ file: "index.html", label: "" }]);
  });

  it("never offers more than five", () => {
    const list = Array.from({ length: 8 }, (_, i) => ({ file: i === 0 ? "index.html" : `variant-${i + 1}.html` }));
    const parsed = parseDesignVariants(list, "index.html");
    expect(parsed.variants).toHaveLength(MAX_DESIGN_VARIANTS);
    expect(parsed.variants.at(-1)!.file).toBe("variant-5.html");
    expect(parsed.warnings.join(" ")).toContain("only the first 5");
  });

  it("falls back to the entry alone for a list that is not one, or an entry in a subfolder", () => {
    expect(parseDesignVariants({ file: "a.html" }, "index.html")).toMatchObject({ variants: [{ file: "index.html" }] });
    expect(parseDesignVariants({}, "index.html").warnings).toHaveLength(1);
    expect(files([{ file: "a.html" }], "pages/home.html")).toEqual(["pages/home.html"]);
  });

  it("caps labels and names variants for the switcher", () => {
    const long = parseDesignVariants([{ file: "index.html", label: "x".repeat(200) }], "index.html");
    expect(long.variants[0]!.label).toHaveLength(MAX_VARIANT_LABEL);
    expect(variantDisplayName({ file: "variant-2.html", label: "Bold" }, 1)).toBe("2 · Bold");
    expect(variantDisplayName({ file: "variant-3.html", label: "" }, 2)).toBe("Variant 3");
    expect(designVariantsOf({ entry: "index.html" })).toEqual([{ file: "index.html", label: "" }]);
  });
});
