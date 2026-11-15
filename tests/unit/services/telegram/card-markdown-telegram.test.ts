/**
 * A PPM Assistant card's body reaches Telegram as formatted HTML, not as escaped Markdown: bold,
 * code and bullets come out as Telegram's own markup, a `<` or `&` (in prose or inside code) is
 * escaped so Telegram never refuses the message, and a body cut to fit still parses. A card's
 * picture captions are cut without breaking a tag or an entity.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { formatManagerCard } from "../../../../src/services/assistant-telegram/assistant-telegram-card-kinds.ts";
import { formatCardFollowup } from "../../../../src/services/assistant-telegram/assistant-telegram-followup-format.ts";
import { TELEGRAM_API_BASE_ENV } from "../../../../src/services/telegram/telegram-api-base.ts";
import { TelegramBotClient } from "../../../../src/services/telegram/telegram-bot-client.ts";
import { parseTelegramHtml, startFakeTelegram, type FakeTelegram } from "../../../helpers/fake-telegram-bot-api.ts";
import type { AssistantCard } from "../../../../src/shared/assistant-cards.ts";

const card = (over: Partial<AssistantCard>): AssistantCard => ({
  id: "3f1c2a9e-5b7d-4e21-9a0c-7d1e2f3a4b5c", kind: "done", projectName: "nxsys", projectKey: "k", sessionId: "mgr",
  title: "NX-6318 fix ready for review", body: "", status: "open", answer: null,
  provenance: "Written by the nxsys manager AI", createdAt: 1, updatedAt: 1, payload: {}, ...over,
});

const visible = (html: string): string => {
  const parsed = parseTelegramHtml(html);
  if ("error" in parsed) throw new Error(`${parsed.error}\n${html}`);
  return parsed.text;
};

const BODY = [
  "## Status",
  "- **Fix** is in `src/payroll/period-close.ts`",
  "- Run `bun test a<b && c` before merging",
  "",
  "```ts",
  "if (a < b && c > d) return;",
  "```",
  "See [the PR](https://github.test/nx/pull/1301) & reply.",
].join("\n");

describe("a card body on Telegram", () => {
  it("is formatted, with < and & escaped in prose and in code", () => {
    const { html } = formatManagerCard(card({ body: BODY }), "full");
    expect(html).toContain("<b>Status</b>");
    expect(html).toContain("• <b>Fix</b> is in <code>src/payroll/period-close.ts</code>");
    expect(html).toContain("<code>bun test a&lt;b &amp;&amp; c</code>");
    expect(html).toContain('<pre><code class="language-ts">if (a &lt; b &amp;&amp; c &gt; d) return;</code></pre>');
    const text = visible(html);
    expect(text).toContain("if (a < b && c > d) return;");
    expect(text).toContain("the PR (https://github.test/nx/pull/1301) & reply.");
    expect(text).not.toContain("**");
    expect(text).not.toContain("```");
  });

  it("shows HTML a manager wrote as text, never as markup", () => {
    const { html } = formatManagerCard(card({ body: '<a href="https://evil.test">click</a> <img src=x> **ok**' }), "full");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
    expect(visible(html)).toContain('<a href="https://evil.test">click</a> <img src=x> ok');
  });

  it("still parses when the body is cut inside a code fence or a bold span", () => {
    const fence = `**Start of a long note\n\`\`\`\n${"x < y & z\n".repeat(400)}`;
    const { html } = formatManagerCard(card({ body: fence }), "full");
    expect(visible(html).length).toBeLessThan(4096);
    const bold = `${"word ".repeat(298)}**cut here ${"y".repeat(300)}**`;
    expect(visible(formatManagerCard(card({ body: bold }), "full").html)).toContain("**cut her…");
  });

  it("keeps a decision's draft verbatim, Markdown markers and all", () => {
    const draft = { to: "#culi-devs", text: "**Not bold** `not code` <b>", sha256: "a".repeat(64) };
    const { html } = formatManagerCard(card({ kind: "needs_decision", body: "**Pick one**", payload: { draft } }), "full");
    expect(html).toContain("<b>Pick one</b>");
    expect(visible(html)).toContain("**Not bold** `not code` <b>");
  });

  it("formats the manager's answer to a reply the same way", () => {
    const { html } = formatCardFollowup({
      text: "- `a<b` & **done**", overflow: false, detail: "full", projectName: "nxsys", newCards: [], url: null,
    });
    expect(html).toContain("• <code>a&lt;b</code> &amp; <b>done</b>");
    expect(visible(html)).toContain("• a<b & done");
  });
});

describe("a card picture's caption", () => {
  const saved = process.env[TELEGRAM_API_BASE_ENV];
  let fake: FakeTelegram;
  beforeAll(() => {
    fake = startFakeTelegram();
    process.env[TELEGRAM_API_BASE_ENV] = fake.url;
  });
  afterAll(() => {
    fake.stop();
    if (saved === undefined) delete process.env[TELEGRAM_API_BASE_ENV];
    else process.env[TELEGRAM_API_BASE_ENV] = saved;
  });

  it("is cut past 1024 characters without breaking an entity or a tag", async () => {
    const bot = new TelegramBotClient(fake.token);
    // `&amp;` straddles character 1024, inside an open <b>: a plain slice would break both.
    const caption = `<b>${"a".repeat(1019)} &amp; tail</b>`;
    const res = await bot.sendPhotos(4343, [{ bytes: new Uint8Array(4), filename: "1.png", caption }]);
    expect(res.ok).toBe(true);
    const sent = fake.sent(4343).at(-1)!;
    // Telegram parsed it (the fake refuses what Telegram would); the cut is measured on the HTML.
    expect(sent.text).toMatch(/^a{1000,}$/);
  });
});
