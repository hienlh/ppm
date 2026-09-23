/**
 * Codex writes maths as `\[ … \]`, which `remark-math` does not read — and Markdown then
 * reads `\[` as an escaped bracket, so the formula rendered as a lone `[`, its body as
 * prose and a lone `]`. The rewrite that fixes it runs over raw Markdown, so most of what
 * follows is about what it must NOT touch: Windows paths, regexes and code.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";
import { normalizeMathDelimiters } from "../../../src/web/lib/markdown-math-delimiters";

installDom();
const { MarkdownRenderer } = await import("../../../src/web/components/shared/markdown-renderer");
afterAll(uninstallDom);

async function render(content: string): Promise<string> {
  const view = await mount(<MarkdownRenderer content={content} />);
  const html = view.container.innerHTML;
  await view.unmount();
  return html;
}

describe("rewrites the delimiters remark-math cannot read", () => {
  it("turns display maths into a math fence", () => {
    expect(normalizeMathDelimiters("\\[\n\\text{Ngân sách} = \\frac{950}{1{,}10}\n\\]"))
      .toBe("$$\n\\text{Ngân sách} = \\frac{950}{1{,}10}\n$$");
  });

  it("turns single-line display maths into one too", () => {
    expect(normalizeMathDelimiters("\\[ x = y \\]")).toBe("$$ x = y $$");
  });

  it("gives inline maths the same fence, since single-dollar maths is off", () => {
    expect(normalizeMathDelimiters("giá trị \\(\\frac{a}{b}\\) ở đây")).toBe("giá trị $$\\frac{a}{b}$$ ở đây");
  });

  it("rewrites every formula in a message, not just the first", () => {
    expect(normalizeMathDelimiters("\\[a\\] rồi \\(b\\) rồi \\[c\\]")).toBe("$$a$$ rồi $$b$$ rồi $$c$$");
  });
});

describe("leaves alone what is not maths", () => {
  it.each([
    ["a message with no delimiters at all", "Không có công thức nào ở đây."],
    // A Windows path opens with the same two characters as inline maths.
    ["a Windows path in prose", "Sửa ở D:\\Projects\\nxsys\\app\\(tabs)\\profile.tsx:108 nhé"],
    ["a Windows path in a code span", "Xem `app\\(tabs)\\_layout.tsx:29-30` rồi báo lại"],
    ["a regex in a fenced block", "```js\nconst re = /\\[a-z\\]/;\n```"],
    ["a formula-shaped line inside a fenced block", "```tex\n\\[\nx = y\n\\]\n```"],
    ["a tilde-fenced block", "~~~\n\\[x\\]\n~~~"],
    ["maths already written the way remark-math reads it", "$$\n x = y \n$$"],
    ["an escaped backslash beside a bracket", "viết \\\\[ như thế \\\\]"],
    // Mid-stream the closing delimiter has not arrived yet.
    ["display maths with no closing delimiter", "\\[\n\\text{chưa xong}"],
    ["inline maths whose closer is on the next line", "mở \\(x\ncòn \\) ở dòng sau"],
    ["an unclosed fence, which is all code until it closes", "```py\n\\[x\\]\n"],
  ])("%s", (_name, source) => {
    expect(normalizeMathDelimiters(source)).toBe(source);
  });

  it("rewrites a real formula in the same message as a path in a code span", () => {
    const source = "Xem `app\\(tabs)\\_layout.tsx` rồi tính \\(x + y\\) nhé";
    expect(normalizeMathDelimiters(source)).toBe("Xem `app\\(tabs)\\_layout.tsx` rồi tính $$x + y$$ nhé");
  });

  it("returns the very same string when there is nothing to do", () => {
    const source = "Một câu bình thường.";
    expect(normalizeMathDelimiters(source)).toBe(source);
  });
});

describe("what the renderer finally shows", () => {
  it("renders the formula Codex wrote, instead of a lone bracket", async () => {
    const html = await render("\\[\n\\text{Ngân sách} = \\frac{950}{1{,}10}\n\\]");
    expect(html).toContain("katex-display");
    // The body must not survive as prose — that is exactly what the bug looked like.
    expect(html).not.toMatch(/<p>\[<br/);
  });

  it("renders inline maths inline, not as its own block", async () => {
    const html = await render("giá trị \\(\\frac{a}{b}\\) ở đây");
    expect(html).toContain("katex");
    expect(html).not.toContain("katex-display");
  });

  it("still renders the dollar form, which already worked", async () => {
    expect(await render("$$\n\\frac{a}{b}\n$$")).toContain("katex-display");
  });

  it("leaves a Windows path in a code span exactly as written", async () => {
    const html = await render("Xem `app\\(tabs)\\_layout.tsx` nhé");
    expect(html).toContain("app\\(tabs)\\_layout.tsx");
    expect(html).not.toContain("katex");
  });

  it("leaves a regex in a code block alone", async () => {
    const html = await render("```js\nconst re = /\\[a-z\\]/;\n```");
    expect(html).toContain("/\\[a-z\\]/");
    expect(html).not.toContain("katex");
  });
});
