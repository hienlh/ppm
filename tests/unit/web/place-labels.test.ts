/**
 * Places that share a name ("Projects" on C: and on D:, both pinned in Windows Quick Access) say
 * where each one is; the same folder listed twice is one place; a lone name is left alone.
 */
import { describe, expect, it } from "bun:test";
import { labelPlaces, placeLabelMap, placeLocationHint } from "../../../src/web/components/os-explorer/place-labels";
import { parentOf } from "../../../src/web/components/os-explorer/host-path-parts";

const HOME = "C:\\Users\\PC";

describe("labelPlaces", () => {
  it("adds where each folder sits when two share a name", () => {
    const labelled = labelPlaces([
      { name: "Projects", path: "D:\\Projects" },
      { name: "Projects", path: "C:\\Users\\PC\\Projects" },
      { name: "Music", path: "C:\\Users\\PC\\Music" },
    ], HOME);
    expect(labelled.map((p) => p.label)).toEqual(["Projects · D:", "Projects · ~", "Music"]);
  });

  it("keeps one place for the same folder listed twice, in either case", () => {
    const labelled = labelPlaces([
      { name: "Projects", path: "C:\\Users\\PC\\Projects" },
      { name: "Projects", path: "c:\\users\\pc\\projects" },
    ], HOME);
    expect(labelled).toHaveLength(1);
    expect(labelled[0]!.label).toBe("Projects");
  });

  it("names a folder deeper under home relative to it, and POSIX paths too", () => {
    expect(placeLocationHint("C:\\Users\\PC\\work\\Projects", HOME)).toBe("~\\work");
    expect(placeLocationHint("/home/me/Projects", "/home/me")).toBe("~");
    expect(placeLocationHint("/srv/Projects", "/home/me")).toBe("/srv");
    expect(placeLocationHint("/Projects", "/home/me")).toBe("/");
  });

  it("maps PPM's pins and the host's pins as one list", () => {
    const labels = placeLabelMap([{ name: "Projects", path: "D:\\Projects" }], {
      homedir: HOME, pinned: [{ name: "Projects", path: "C:\\Users\\PC\\Projects" }],
    });
    expect(labels.get("D:\\Projects")).toBe("Projects · D:");
    expect(labels.get("C:\\Users\\PC\\Projects")).toBe("Projects · ~");
  });
});

describe("parentOf", () => {
  it("answers a folder's parent and nothing for a root", () => {
    expect(parentOf("D:\\tiktok\\story\\a.mp4")).toBe("D:\\tiktok\\story");
    expect(parentOf("D:\\tiktok")).toBe("D:\\");
    expect(parentOf("D:\\")).toBeNull();
    expect(parentOf("/srv/a.txt")).toBe("/srv");
    expect(parentOf("/srv")).toBe("/");
    expect(parentOf("/")).toBeNull();
  });
});
