/**
 * The "Hiểu là: heard → meant" line an AI opens with: parsed strictly, split off the answer, and
 * nothing else read as one.
 */
import { describe, expect, it } from "bun:test";
import { formatUnderstoodPairs, parseUnderstoodPairs, splitUnderstoodLine } from "../../../src/shared/voice-understood.ts";

describe("parseUnderstoodPairs", () => {
  it("reads one or several pairs, whichever arrow and emphasis the model used", () => {
    expect(parseUnderstoodPairs("Hiểu là: BPM → PPM")).toEqual([{ heard: "BPM", meant: "PPM" }]);
    expect(parseUnderstoodPairs("**Hiểu là:** BPM -> PPM; scale => Slack")).toEqual([
      { heard: "BPM", meant: "PPM" }, { heard: "scale", meant: "Slack" },
    ]);
    expect(parseUnderstoodPairs("Understood as: `hô nô` → `Hono`.")).toEqual([{ heard: "hô nô", meant: "Hono" }]);
    expect(parseUnderstoodPairs("hiểu là : “ta lệnh” → “ra lệnh”")).toEqual([{ heard: "ta lệnh", meant: "ra lệnh" }]);
  });

  it("is not a line that only starts the same way, nor one with nothing to learn", () => {
    expect(parseUnderstoodPairs("Hiểu là anh muốn sửa route")).toBeNull();
    expect(parseUnderstoodPairs("Em hiểu là: BPM → PPM")).toBeNull();
    expect(parseUnderstoodPairs("Hiểu là: PPM → ppm")).toBeNull();
    expect(parseUnderstoodPairs("Hiểu là: BPM")).toBeNull();
    expect(parseUnderstoodPairs(`Hiểu là: ${"x".repeat(61)} → y`)).toBeNull();
  });

  it("keeps each heard word once and at most six pairs", () => {
    const line = `Hiểu là: ${Array.from({ length: 9 }, (_, i) => `a${i} → b${i}`).join("; ")}; a0 → c`;
    expect(parseUnderstoodPairs(line)).toHaveLength(6);
  });
});

describe("splitUnderstoodLine", () => {
  it("splits the line off the answer, blank lines before it allowed", () => {
    expect(splitUnderstoodLine("\n\nHiểu là: BPM → PPM\n\nĐã sửa xong.")).toEqual({ pairs: [{ heard: "BPM", meant: "PPM" }], rest: "Đã sửa xong." });
    expect(splitUnderstoodLine("Hiểu là: BPM → PPM")).toEqual({ pairs: [{ heard: "BPM", meant: "PPM" }], rest: "" });
  });

  it("reads only the first line of the answer", () => {
    expect(splitUnderstoodLine("Đã sửa xong.\nHiểu là: BPM → PPM")).toBeNull();
    expect(splitUnderstoodLine("   ")).toBeNull();
  });

  it("writes the pairs as the chat shows them", () => {
    expect(formatUnderstoodPairs([{ heard: "BPM", meant: "PPM" }, { heard: "scale", meant: "Slack" }])).toBe("BPM → PPM; scale → Slack");
  });
});
