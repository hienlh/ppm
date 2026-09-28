import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { validateExportEntry } from "../../../src/services/design/export/design-export-entry.ts";

const DIR = join("/", "work", "project", "designs", "landing");

describe("validateExportEntry", () => {
  it("accepts an .html or .htm page inside the design, as a /-separated relative path", () => {
    expect(validateExportEntry("index.html", DIR)).toEqual({ rel: "index.html", abs: join(DIR, "index.html") });
    expect(validateExportEntry("pages/About_2.htm", DIR).rel).toBe("pages/About_2.htm");
  });

  it("refuses traversal, dot segments, encodings, separators and other file types", () => {
    for (const bad of [
      "../other/index.html", "..", "a/../../x.html", "%2F..%2Fx.html", "%2e%2e/x.html", ".design/x.html",
      "pages/.hidden/x.html", ".x.html", "pages\\x.html", "/etc/passwd.html", "C:/x.html", "a//b.html",
      "x.html\0", "index.htmlx", "index.css", "", "a".repeat(201) + ".html", "./index.html",
    ]) {
      expect(() => validateExportEntry(bad, DIR)).toThrow();
    }
  });

  it("refuses a non-string and answers 400", () => {
    for (const bad of [undefined, null, 5, ["index.html"]]) {
      try {
        validateExportEntry(bad, DIR);
        throw new Error("accepted");
      } catch (e) {
        expect((e as { status?: number }).status).toBe(400);
      }
    }
  });
});
