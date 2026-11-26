/**
 * The preview a folded answered card shows: the manager's Markdown as one line of plain text, cut
 * to length at a word with "…", without splitting a Vietnamese letter from its accent.
 */
import { describe, expect, it } from "bun:test";
import { cutPreview, markdownPreview, markdownToPlainText } from "../../../src/shared/plain-text-preview.ts";

describe("markdownToPlainText", () => {
  it("takes out emphasis, headings, quotes, lists and task boxes", () => {
    const md = "## Kết quả\n\n> **Đã xong** phần _một_.\n\n- [x] chạy ~~lại~~ test\n- bước *hai*\n1. bước ba";
    expect(markdownToPlainText(md)).toBe("Kết quả Đã xong phần một. chạy lại test bước hai bước ba");
  });

  it("keeps a link's and an image's text, an autolink's address, and inline code's content", () => {
    expect(markdownToPlainText("Xem [PR #12](https://x.test/pr/12) và ![ảnh](a.png), <https://x.test/a> hoặc `bun test`."))
      .toBe("Xem PR #12 và ảnh, https://x.test/a hoặc bun test.");
  });

  it("drops code fences and rules but keeps the code, and reads a table's cells as a list", () => {
    const md = "Chạy:\n```bash\nbun test\n```\n---\n| Bước | Kết quả |\n|---|:---:|\n| 1 | xanh |";
    expect(markdownToPlainText(md)).toBe("Chạy: bun test Bước · Kết quả 1 · xanh");
  });

  it("keeps underscores inside words and unescapes escaped characters", () => {
    expect(markdownToPlainText("Biến snake_case_name và \\*không\\* in nghiêng")).toBe("Biến snake_case_name và *không* in nghiêng");
  });

  it("removes HTML tags and collapses every line break and run of spaces", () => {
    expect(markdownToPlainText("Một<br>hai\n\n\n   ba\t<b>bốn</b>")).toBe("Một hai ba bốn");
  });

  it("composes decomposed Vietnamese (NFD) letters", () => {
    const nfd = "Được anh".normalize("NFD");
    expect(markdownToPlainText(nfd)).toBe("Được anh".normalize("NFC"));
  });
});

describe("cutPreview", () => {
  it("returns text that fits unchanged", () => {
    expect(cutPreview("Ngắn thôi.", 20)).toBe("Ngắn thôi.");
  });

  it("cuts at a word near the limit, drops trailing punctuation, and adds …", () => {
    const cut = cutPreview("Không ạ, chạy cái này tốn nhiều quota đấy, khoảng bốn mươi phần trăm.", 30);
    expect(cut).toBe("Không ạ, chạy cái này tốn…");
    expect(Array.from(cut).length).toBeLessThanOrEqual(30);
  });

  it("cuts a long word mid-word when no space is near", () => {
    expect(cutPreview("a".repeat(100), 10)).toBe(`${"a".repeat(9)}…`);
  });

  it("never splits a surrogate pair or a letter from its combining accent", () => {
    expect(cutPreview("😀".repeat(20), 5)).toBe(`${"😀".repeat(4)}…`);
    // "ệ" decomposed is e + U+0323 + U+0302: the cut backs off to a whole letter.
    const word = "Vie\u0323\u0302tnam".repeat(10);
    const cut = cutPreview(word, 5);
    expect(/\p{M}…$/u.test(cut)).toBe(false);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("work on hostile input", () => {
  // Line rules once used `\s`, which under `m` spans line breaks: 2000 blank lines took 1.2 s.
  const inputs: Array<[string, string]> = [
    ["blank lines", `a${"\n".repeat(8000)}b`],
    ["blank lines with spaces", `a${"\n ".repeat(4000)}b`],
    ["blank lines with tabs", `a${"\n\t".repeat(4000)}b`],
    ["open brackets", "[".repeat(8000)],
    ["stars", "*".repeat(8000)],
    ["underscores", "_ ".repeat(4000)],
    ["pipes and dashes", "|-".repeat(4000)],
    ["backticks", "`a".repeat(4000)],
    ["angle brackets", "<a ".repeat(3000)],
  ];
  for (const [name, input] of inputs) {
    it(`finishes quickly on ${name}`, () => {
      const t0 = performance.now();
      markdownPreview(input, 280);
      expect(performance.now() - t0).toBeLessThan(150);
    });
  }

  it("reads only the start of a long text, and never leaves half a surrogate pair", () => {
    expect(markdownPreview(`${"😀".repeat(5000)}`, 10)).toBe(`${"😀".repeat(9)}…`);
    expect(markdownPreview(`x${"😀".repeat(3000)}`, 160).endsWith("…")).toBe(true);
  });

  it("keeps stars that are arithmetic", () => {
    expect(markdownToPlainText("2*3*4 = 24, *nhấn mạnh*")).toBe("2*3*4 = 24, nhấn mạnh");
  });
});

describe("markdownPreview", () => {
  it("is empty for no text, blank text, or markup with no words in it", () => {
    expect(markdownPreview(undefined, 50)).toBe("");
    expect(markdownPreview("", 50)).toBe("");
    expect(markdownPreview("  \n\n ", 50)).toBe("");
    expect(markdownPreview("---\n```\n```", 50)).toBe("");
  });

  it("is the plain text, cut to length", () => {
    const md = "**Không ạ** — chạy cái này *tốn nhiều quota* đấy:\n- Full regression: ~40% quota tuần.";
    const p = markdownPreview(md, 60);
    expect(p).toBe("Không ạ — chạy cái này tốn nhiều quota đấy: Full regression…");
    expect(p).not.toContain("*");
  });
});
