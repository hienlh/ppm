import { describe, expect, it } from "bun:test";
import {
  markdownToTelegramHtml,
  redactForTelegram,
  splitTelegramHtml,
  stripTelegramHtml,
  TELEGRAM_MESSAGE_MAX,
} from "../../../../src/services/telegram/telegram-html-format.ts";
import { parseTelegramHtml } from "../../../helpers/fake-telegram-bot-api.ts";

/** Telegram would take it: the fake's parser is written apart from the formatter on purpose. */
function expectValid(html: string): string {
  const parsed = parseTelegramHtml(html);
  if ("error" in parsed) throw new Error(`${parsed.error}\n---\n${html}`);
  return parsed.text;
}

describe("markdownToTelegramHtml", () => {
  it("escapes text before formatting it", () => {
    const html = markdownToTelegramHtml("if a < b && c > d then **ok**");
    expect(html).toBe("if a &lt; b &amp;&amp; c &gt; d then <b>ok</b>");
    expectValid(html);
  });

  it("leaves code blocks literal, with the language kept", () => {
    const html = markdownToTelegramHtml("Try:\n```ts\nconst x = a < b && **c**;\n```\ndone");
    expect(html).toBe('Try:\n<pre><code class="language-ts">const x = a &lt; b &amp;&amp; **c**;</code></pre>\ndone');
    expectValid(html);
  });

  it("runs an unclosed fence to the end", () => {
    const html = markdownToTelegramHtml("```\n<div>\nmore");
    expect(html).toBe("<pre>&lt;div&gt;\nmore</pre>");
    expectValid(html);
  });

  it("formats inline code, bold, italic and strikethrough", () => {
    const html = markdownToTelegramHtml("Run `a<b` then **bold _it_** and *one* or ~~gone~~");
    expect(html).toBe("Run <code>a&lt;b</code> then <b>bold <i>it</i></b> and <i>one</i> or <s>gone</s>");
    expectValid(html);
  });

  it("does not italicise snake_case or the inside of a URL", () => {
    const html = markdownToTelegramHtml("set my_var_name, see https://x.dev/a_b_c and *real*");
    expect(html).toBe("set my_var_name, see https://x.dev/a_b_c and <i>real</i>");
    expectValid(html);
  });

  it("shows a link's destination next to its text", () => {
    expect(markdownToTelegramHtml("[the docs](https://ppm.dev/a?b=1&c=2)")).toBe("the docs (https://ppm.dev/a?b=1&amp;c=2)");
    expect(markdownToTelegramHtml("[https://ppm.dev](https://ppm.dev)")).toBe("https://ppm.dev");
  });

  it("turns headings bold and bullets into dots", () => {
    const html = markdownToTelegramHtml("# Title\n## **C#** notes\n- one\n  * two\n---");
    expect(html).toBe("<b>Title</b>\n<b>C# notes</b>\n• one\n  • two\n──────────");
    expectValid(html);
  });

  it("lays a table out as aligned monospace text", () => {
    const md = "| Chat | State |\n|---|:--:|\n| **api** | waiting <b> |\n| web-ui | done |";
    const html = markdownToTelegramHtml(md);
    expect(html).toBe(
      "<pre>Chat   | State\n-------|------------\napi    | waiting &lt;b&gt;\nweb-ui | done</pre>",
    );
    expectValid(html);
  });

  it("never emits crossed tags", () => {
    for (const md of ["**a *b** c*", "~~a **b~~ c**", "*a **b* c**", "_a *b_ c*"]) expectValid(markdownToTelegramHtml(md));
  });

  it("keeps Vietnamese text intact", () => {
    const html = markdownToTelegramHtml("**Xong rồi** — chat *đang chờ* bạn duyệt & trả lời");
    expect(html).toBe("<b>Xong rồi</b> — chat <i>đang chờ</i> bạn duyệt &amp; trả lời");
    expectValid(html);
  });

  it("produces HTML Telegram takes for an answer with <, a table and a code block", () => {
    const md = [
      "## Kết quả",
      "Số chat có a < b: **3**",
      "| Project | Chats |",
      "| --- | --- |",
      "| ppm | 2 |",
      "```bash",
      "echo \"<ok>\" && exit",
      "```",
      "Xem [log](http://localhost:8080/logs?x=1&y=2).",
    ].join("\n");
    const text = expectValid(markdownToTelegramHtml(md));
    expect(text).toContain("a < b");
    expect(text).toContain('echo "<ok>" && exit');
    expect(text).toContain("log (http://localhost:8080/logs?x=1&y=2)");
  });
});

describe("splitTelegramHtml", () => {
  it("keeps a short message whole and drops an empty one", () => {
    expect(splitTelegramHtml("<b>hi</b>")).toEqual(["<b>hi</b>"]);
    expect(splitTelegramHtml("  \n ")).toEqual([]);
  });

  it("cuts 10 000 characters inside open tags into valid messages", () => {
    const inner = Array.from({ length: 400 }, (_, i) => `dòng ${i} a &lt; b`).join("\n");
    const html = `<b>Head</b>\n<blockquote><i>${inner}</i></blockquote>\n<pre><code class="language-ts">${"x &amp; y\n".repeat(700)}</code></pre>`;
    expect(html.length).toBeGreaterThan(10_000);
    const chunks = splitTelegramHtml(html);
    expect(chunks.length).toBeGreaterThan(2);
    let visible = "";
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX);
      visible += expectValid(chunk);
    }
    // Nothing lost but the line breaks a cut lands on.
    expect(visible.replace(/\s/g, "")).toBe(stripTelegramHtml(html).replace(/\s/g, ""));
    expect(chunks[1]!.startsWith("<blockquote><i>") || chunks[1]!.startsWith("<pre>")).toBe(true);
  });

  it("never cuts an entity, a tag or a surrogate pair, even with no spaces to cut at", () => {
    const html = `<b>${"😀&amp;".repeat(800)}</b>`;
    const chunks = splitTelegramHtml(html, 100);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expectValid(chunk);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    }
    expect(chunks.map((c) => stripTelegramHtml(c)).join("")).toBe("😀&".repeat(800));
  });

  it("prefers a line break to a space", () => {
    const html = `${"word ".repeat(30)}\n${"next ".repeat(30)}`;
    const [first] = splitTelegramHtml(html, 200);
    expect(first!.endsWith("\n")).toBe(true);
  });
});

describe("stripTelegramHtml", () => {
  it("returns the text Telegram would show, links with their address", () => {
    expect(stripTelegramHtml('<b>a &lt; b</b> &amp; <a href="https://x.dev">site</a> &#39;q&#x27;')).toBe("a < b & site (https://x.dev) 'q'");
  });
});

describe("redactForTelegram", () => {
  it("takes out secrets and leaves the person's own details", () => {
    const token = `123456789:AA${"x".repeat(33)}`;
    const out = redactForTelegram(`bot ${token} key sk-ant-${"y".repeat(30)} at /home/dev mail a@b.co chat 53952680-0b07-4c1e-9d3a-1b2c3d4e5f60`);
    expect(out).not.toContain(token);
    expect(out).toContain("123456789:[REDACTED]");
    expect(out).not.toContain("sk-ant-");
    expect(out).toContain("/home/dev");
    expect(out).toContain("a@b.co");
    expect(out).toContain("53952680-0b07-4c1e-9d3a-1b2c3d4e5f60");
  });
});
