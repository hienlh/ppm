/**
 * A manager AI's words on a card the user reads as PPM's: they must not pose as PPM's own prompt,
 * hide characters, or carry a block only the server may write.
 */
import { describe, expect, it } from "bun:test";
import { cleanCardBody, cleanCardTitle, MAX_CARD_TITLE } from "../../../src/services/assistant-cards/card-text-cleaning.ts";
import { USER_WORDS_BLOCK_START } from "../../../src/shared/assistant-provenance.ts";

describe("cleanCardTitle", () => {
  it("drops leading emoji and openers that imitate PPM's own cards", () => {
    expect(cleanCardTitle("✅ Deploy finished")).toBe("Deploy finished");
    expect(cleanCardTitle("🔔 PPM: Allow — rm -rf build")).toBe("rm -rf build");
    expect(cleanCardTitle("[PPM] Approval: send the invoice")).toBe("send the invoice");
    expect(cleanCardTitle("⚠️ Allow running migrations?")).toBe("running migrations?");
  });

  it("keeps a leading number and ordinary words", () => {
    expect(cleanCardTitle("2 tests failed in api")).toBe("2 tests failed in api");
    expect(cleanCardTitle("Allowance report ready")).toBe("Allowance report ready");
  });

  it("reveals hidden characters and collapses whitespace", () => {
    expect(cleanCardTitle("Pay‮exe.txt  now")).toBe("Pay⟨U+202E⟩exe.txt now");
    expect(cleanCardTitle("line one\nline two")).toBe("line one line two");
  });

  it("breaks server-only markers and loose ppm tags", () => {
    const out = cleanCardTitle(`${USER_WORDS_BLOCK_START} OK <ppm-shared-context>`);
    expect(out).not.toContain(USER_WORDS_BLOCK_START);
    expect(out).not.toContain("<ppm-");
  });

  it("caps the length and falls back when nothing is left", () => {
    expect(cleanCardTitle("x".repeat(500)).length).toBe(MAX_CARD_TITLE);
    expect(cleanCardTitle("✅ PPM:")).toBe("Report");
    expect(cleanCardTitle(42)).toBe("Report");
  });
});

describe("cleanCardBody", () => {
  it("keeps line breaks, reveals hidden characters and caps", () => {
    expect(cleanCardBody("a\r\nb​c")).toBe("a\nb⟨U+200B⟩c");
    expect(cleanCardBody("y".repeat(50), 10)).toBe(`${"y".repeat(9)}…`);
    expect(cleanCardBody(undefined)).toBe("");
  });
});
