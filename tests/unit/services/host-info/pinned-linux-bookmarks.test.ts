import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getLinuxPinned } from "../../../../src/services/host-info/pinned-linux-bookmarks.ts";

const FIXTURES = join(import.meta.dir, "../../../fixtures/host-info");
const gtkFixture = readFileSync(join(FIXTURES, "gtk-bookmarks.txt"), "utf-8");
const kdeFixture = readFileSync(join(FIXTURES, "user-places.xbel"), "utf-8");

describe("getLinuxPinned", () => {
  test("parses GTK bookmarks, decodes percent-encoding, skips malformed/non-file:// lines", async () => {
    const pinned = await getLinuxPinned("/home/victor", [], {
      readFile: async (p) => {
        if (p.endsWith("gtk-3.0/bookmarks")) return gtkFixture;
        throw new Error("ENOENT");
      },
    });
    expect(pinned).toEqual([
      { name: "Projects", path: "/home/victor/Projects", source: "gtk" },
      { name: "Downloads", path: "/home/victor/Downloads", source: "gtk" },
      { name: "My Docs", path: "/home/victor/My Docs", source: "gtk" },
    ]);
  });

  test("falls back to gtk-4.0/bookmarks when gtk-3.0 is missing", async () => {
    const pinned = await getLinuxPinned("/home/victor", [], {
      readFile: async (p) => {
        if (p.endsWith("gtk-4.0/bookmarks")) return "file:///home/victor/Only4 Only4\n";
        throw new Error("ENOENT");
      },
    });
    expect(pinned).toEqual([{ name: "Only4", path: "/home/victor/Only4", source: "gtk" }]);
  });

  test("parses KDE user-places.xbel and dedupes against GTK by path (GTK wins)", async () => {
    const pinned = await getLinuxPinned("/home/victor", [], {
      readFile: async (p) => {
        if (p.endsWith("gtk-3.0/bookmarks")) return gtkFixture;
        if (p.endsWith("user-places.xbel")) return kdeFixture;
        throw new Error("ENOENT");
      },
    });
    // /home/victor/Projects appears in both GTK and KDE fixtures — GTK's "Projects" name must win.
    const projects = pinned.filter((p) => p.path === "/home/victor/Projects");
    expect(projects).toEqual([{ name: "Projects", path: "/home/victor/Projects", source: "gtk" }]);
    // KDE-only entry still comes through.
    expect(pinned.find((p) => p.path === "/home/victor/Documents")).toEqual({
      name: "Documents",
      path: "/home/victor/Documents",
      source: "kde",
    });
  });

  test("missing GTK and KDE files both yield warnings, empty list, never throws", async () => {
    const warnings: string[] = [];
    const pinned = await getLinuxPinned("/home/victor", warnings, {
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(pinned).toEqual([]);
    expect(warnings.length).toBe(2);
  });
});
