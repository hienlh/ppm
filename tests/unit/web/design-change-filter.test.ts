import { describe, expect, it } from "bun:test";
import { classifyDesignChange } from "../../../src/web/lib/design/design-change-filter";

describe("classifyDesignChange", () => {
  it("reloads for any rendered file of the design", () => {
    for (const path of ["designs/landing/index.html", "designs/landing/css/app.css", "designs/landing/img/a.png"]) {
      expect(classifyDesignChange(path, "landing")).toBe("reload");
    }
  });

  it("reloads for the shared tokens every design links", () => {
    expect(classifyDesignChange("designs/tokens.css", "landing")).toBe("reload");
  });

  it("refetches the manifest for design.json and for the folder itself", () => {
    expect(classifyDesignChange("designs/landing/design.json", "landing")).toBe("manifest");
    expect(classifyDesignChange("designs/landing", "landing")).toBe("manifest");
  });

  it("ignores .design/, other designs, the design guide and the rest of the project", () => {
    for (const path of [
      "designs/landing/.design/history/x/index.html",
      "designs/landing/.design",
      "designs/landing-v2/index.html",
      "designs/other/index.html",
      "designs/DESIGN.md",
      "src/app.tsx",
      "",
    ]) {
      expect(classifyDesignChange(path, "landing")).toBeNull();
    }
  });

  it("normalises backslashes and a leading ./ or /", () => {
    expect(classifyDesignChange("designs\\landing\\index.html", "landing")).toBe("reload");
    expect(classifyDesignChange("./designs/landing/index.html", "landing")).toBe("reload");
    expect(classifyDesignChange("/designs/tokens.css", "landing")).toBe("reload");
  });

  it("does nothing without a slug", () => {
    expect(classifyDesignChange("designs/landing/index.html", "")).toBeNull();
  });
});
