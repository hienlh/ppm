import { describe, it, expect } from "bun:test";
import {
  escapeHtml,
  markdownToTelegramHtml,
  chunkMessage,
  truncateForPreview,
} from "../../../../src/services/ppmbot/ppmbot-formatter.ts";

describe("PPMBot Formatter", () => {
  describe("escapeHtml", () => {
    it("should escape angle brackets", () => {
      expect(escapeHtml("<script>alert(1)</script>")).toBe(
        "&lt;script&gt;alert(1)&lt;/script&gt;",
      );
    });

    it("should escape ampersand and quotes", () => {
      expect(escapeHtml('a & "b"')).toBe('a &amp; &quot;b&quot;');
    });
  });

  describe("markdownToTelegramHtml", () => {
    it("should convert bold", () => {
      expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>");
    });

    it("should convert italic", () => {
      expect(markdownToTelegramHtml("*hello*")).toBe("<i>hello</i>");
    });

    it("should convert inline code", () => {
      expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
    });

    it("should convert code blocks", () => {
      const input = "```ts\nconst x = 1;\n```";
      const result = markdownToTelegramHtml(input);
      expect(result).toContain("<pre>");
      expect(result).toContain("const x = 1;");
    });

    it("should convert links", () => {
      expect(markdownToTelegramHtml("[PPM](https://example.com)")).toBe(
        '<a href="https://example.com">PPM</a>',
      );
    });

    it("should convert strikethrough", () => {
      expect(markdownToTelegramHtml("~~old~~")).toBe("<s>old</s>");
    });

    it("should escape HTML inside code blocks", () => {
      const input = "```\n<div>test</div>\n```";
      const result = markdownToTelegramHtml(input);
      expect(result).toContain("&lt;div&gt;");
    });
  });

  describe("chunkMessage", () => {
    it("should return single chunk for short text", () => {
      const chunks = chunkMessage("hello world");
      expect(chunks).toEqual(["hello world"]);
    });

    it("should split at paragraph boundaries", () => {
      const text = "a".repeat(3000) + "\n\n" + "b".repeat(2000);
      const chunks = chunkMessage(text, 4096);
      expect(chunks.length).toBe(2);
      expect(chunks[0]!.length).toBeLessThanOrEqual(4096);
      expect(chunks[1]!.length).toBeLessThanOrEqual(4096);
    });

    it("should never produce chunks exceeding max length", () => {
      const text = "a".repeat(10000);
      const chunks = chunkMessage(text, 4096);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      }
    });
  });

  describe("truncateForPreview", () => {
    it("should not truncate short text", () => {
      expect(truncateForPreview("hello", 200)).toBe("hello");
    });

    it("should truncate with ellipsis", () => {
      const long = "a".repeat(300);
      const result = truncateForPreview(long, 200);
      expect(result.length).toBe(200);
      expect(result.endsWith("\u2026")).toBe(true);
    });
  });
});
