/**
 * Text a person approves is shown with every character that draws nothing or reorders its
 * neighbours replaced by a visible marker; ordinary text, tabs and newlines pass through.
 */
import { describe, expect, it } from "bun:test";
import { hasHiddenCharacters, hiddenCharacterMarker, revealHiddenCharacters } from "../../../src/web/lib/reveal-hidden-characters";

const cp = (n: number) => String.fromCodePoint(n);

describe("revealHiddenCharacters", () => {
  it.each([
    0x202e, 0x202a, 0x2066, 0x2069, 0x200e, 0x200f, 0x061c, // direction controls
    0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x180e, 0x3164, // zero-width and blank-looking
    0x2028, 0x2029, 0x000d, 0x0000, 0x001b, 0x0085, // separators and controls
    0xe0041, // a tag character, outside the BMP
  ])("marks code point %d", (code) => {
    const text = `a${cp(code)}b`;
    expect(hasHiddenCharacters(text)).toBe(true);
    expect(revealHiddenCharacters(text)).toEqual([{ text: "a" }, { hidden: cp(code), marker: hiddenCharacterMarker(cp(code)) }, { text: "b" }]);
  });

  it("formats the marker with at least four hex digits", () => {
    expect(hiddenCharacterMarker(cp(0x202e))).toBe("⟨U+202E⟩");
    expect(hiddenCharacterMarker(cp(0x0d))).toBe("⟨U+000D⟩");
    expect(hiddenCharacterMarker(cp(0xe0041))).toBe("⟨U+E0041⟩");
  });

  it("leaves ordinary text alone, accents, emoji and tabs included", () => {
    const text = "SELECT 'héllo — ✓ 👍';\n\tDONE";
    expect(hasHiddenCharacters(text)).toBe(false);
    expect(revealHiddenCharacters(text)).toEqual([{ text }]);
    expect(revealHiddenCharacters("")).toEqual([]);
  });

  it("answers the same on repeated calls (the shared pattern keeps no position)", () => {
    const text = `x${cp(0x202e)}`;
    expect(hasHiddenCharacters(text)).toBe(true);
    expect(hasHiddenCharacters(text)).toBe(true);
    expect(revealHiddenCharacters(text)).toHaveLength(2);
  });
});
