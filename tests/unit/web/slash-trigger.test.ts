import { describe, expect, it } from "bun:test";
import { replaceSlashQuery, slashQueryBefore, stripSlashQuery } from "../../../src/web/lib/slash-trigger.ts";

describe("slash trigger", () => {
  it("opens a query only at the start or after whitespace", () => {
    expect(slashQueryBefore("/")).toBe("");
    expect(slashQueryBefore("use /ui-u")).toBe("ui-u");
    expect(slashQueryBefore("line\n/ak:")).toBe("ak:");
    expect(slashQueryBefore("src/app")).toBeNull();
    expect(slashQueryBefore("use /ui done")).toBeNull();
  });

  it("replaces the query with the picked token, keeping the whitespace before it", () => {
    expect(replaceSlashQuery("/ui", "/ak:ui-ux-pro-max")).toBe("/ak:ui-ux-pro-max ");
    expect(replaceSlashQuery("use\n/ui", "$imagegen")).toBe("use\n$imagegen ");
    expect(replaceSlashQuery("no query", "/x")).toBe("no query");
  });

  it("strips the query for a pick that is not inserted as text", () => {
    expect(stripSlashQuery("ask /rev")).toBe("ask ");
    expect(stripSlashQuery("/rev")).toBe("");
  });
});
