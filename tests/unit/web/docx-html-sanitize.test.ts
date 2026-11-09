/**
 * mammoth converts a `.docx` to HTML and does no sanitising, so a `javascript:` hyperlink in a
 * document (reproduced in Chromium: one click read the auth token) or a smuggled `<script>`
 * would reach the preview's `innerHTML` live. `sanitizeDocxHtml` holds it to an allow-list while
 * keeping the formatting, links, tables and embedded images mammoth actually produces.
 */
import { describe, expect, it } from "bun:test";
import { sanitizeDocxHtml } from "../../../src/web/components/shared/docx-html-sanitize";

const PWN = "window.__pwned=localStorage.getItem('ppm-auth-token')";

describe("docx HTML sanitiser drops anything active", () => {
  it.each([
    ["script", `<p>a</p><script>${PWN}</script>`, ["<script"]],
    ["javascript link", `<a href="javascript:${PWN}">x</a>`, ["javascript:"]],
    ["mixed-case javascript link", `<a href="JAVAScript:${PWN}">x</a>`, ["javascript:", "JAVAScript:"]],
    ["event handler", `<p onmouseover="${PWN}">hover</p>`, ["onmouseover"]],
    ["img onerror", `<img src="x" onerror="${PWN}">`, ["onerror"]],
    ["iframe", `<iframe src="https://evil.test"></iframe>`, ["<iframe"]],
    ["object", `<object data="data:text/html,x"></object>`, ["<object"]],
    ["data:text/html image", `<img src="data:text/html,<script>${PWN}</script>">`, ["data:text/html", "<script"]],
    ["style tag", `<style>body{display:none}</style>`, ["<style"]],
    ["form", `<form action="https://evil.test"><button>go</button></form>`, ["<form", "<button"]],
  ])("drops %s", (_name, input, forbidden) => {
    const out = sanitizeDocxHtml(input);
    for (const f of forbidden) expect(out).not.toContain(f);
  });

  it("keeps the link text but not the live href", () => {
    const out = sanitizeDocxHtml(`<a href="javascript:${PWN}">click me</a>`);
    expect(out).toContain("click me");
    expect(out).not.toContain("href=");
  });
});

describe("docx HTML sanitiser keeps ordinary document markup", () => {
  it("formatting, headings, lists, tables, external links and embedded images", () => {
    const input = [
      "<h1>Quarterly report</h1>",
      "<p>Plain text with <strong>bold</strong> and <em>italic</em></p>",
      '<p><a href="https://example.com/docs">example site</a></p>',
      '<p><a href="mailto:a@b.test">mail</a></p>',
      "<ul><li>one</li><li>two</li></ul>",
      "<table><tr><td><p>cell0</p></td><td><p>cell1</p></td></tr></table>",
      '<p><img src="data:image/png;base64,iVBORw0KGgo=" width="10" height="10" /></p>',
      '<p><img src="https://example.com/a.png" /></p>',
    ].join("");
    const out = sanitizeDocxHtml(input);
    expect(out).toContain("<h1>Quarterly report</h1>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain('href="https://example.com/docs"');
    expect(out).toContain('href="mailto:a@b.test"');
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<td><p>cell0</p></td>");
    expect(out).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(out).toContain('width="10"');
    expect(out).toContain('src="https://example.com/a.png"');
  });
});
