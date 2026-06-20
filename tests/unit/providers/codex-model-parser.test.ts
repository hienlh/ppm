import { describe, it, expect } from "bun:test";
import { parseModelList } from "../../../src/providers/codex-app-server/codex-model-parser.ts";

describe("parseModelList", () => {
  it("maps id→value and displayName→label", () => {
    expect(parseModelList([{ id: "gpt-5", displayName: "GPT-5" }]))
      .toEqual([{ value: "gpt-5", label: "GPT-5" }]);
  });
  it("falls back to id when displayName missing", () => {
    expect(parseModelList([{ id: "o4" }])).toEqual([{ value: "o4", label: "o4" }]);
  });
  it("drops hidden models", () => {
    expect(parseModelList([{ id: "a", hidden: true }, { id: "b" }]))
      .toEqual([{ value: "b", label: "b" }]);
  });
  it("flattens a multi-page collected data array", () => {
    const page1 = [{ id: "a" }];
    const page2 = [{ id: "b" }];
    expect(parseModelList([...page1, ...page2])).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });
  it("empty / malformed → []", () => {
    expect(parseModelList([])).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList([{ noId: true }, "junk", 5])).toEqual([]);
  });
});
