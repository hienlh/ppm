import { describe, it, expect } from "bun:test";
import { selectSdkOnlyCommands } from "../../../../src/services/slash-discovery/sdk-commands.ts";
import type { SlashItem } from "../../../../src/services/slash-discovery/types.ts";

function sdkItem(name: string): SlashItem {
  return { type: "builtin", name, description: "", scope: "bundled", handler: "sdk" };
}

describe("selectSdkOnlyCommands", () => {
  it("keeps commands that exist nowhere else", () => {
    const result = selectSdkOnlyCommands([sdkItem("context"), sdkItem("usage")], []);

    expect(result.map((i) => i.name)).toEqual(["context", "usage"]);
  });

  it("drops skills the filesystem scan already found", () => {
    // The SDK reports plugin skills under the same namespaced name the SKILL.md
    // frontmatter declares, so these are genuine duplicates.
    const result = selectSdkOnlyCommands(
      [sdkItem("ak:debug"), sdkItem("context")],
      ["ak:debug", "ak:scout"],
    );

    expect(result.map((i) => i.name)).toEqual(["context"]);
  });

  it("lets a static builtin win over the SDK's version of the same name", () => {
    const result = selectSdkOnlyCommands([sdkItem("clear"), sdkItem("compact")], ["clear", "compact"]);

    expect(result).toEqual([]);
  });

  it("returns nothing when the SDK reported nothing", () => {
    expect(selectSdkOnlyCommands([], ["clear"])).toEqual([]);
  });
});
