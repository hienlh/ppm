import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { HTML_PREVIEW_BRIDGE_JS, htmlPreviewBridgeTag } from "../../../src/services/design/bridge/html-preview-bridge.ts";
import { parseChildMessage } from "../../../src/shared/design-bridge-protocol.ts";

/**
 * The HTML preview's link hand-off, run as the real assembled preview bridge in a happy-dom
 * window whose `parent` records what is posted. The preview's sandbox swallows popups, so a
 * link leaving the page must reach the parent as `open-link`; a link to another page of the
 * preview, and anything the page handled itself, must not.
 */

const NONCE = "abcdefghijklmnop";
const GEN = "0123456789abcdef";
const PAGE = "http://localhost:3214/api/html-preview/content/tok/index.html";

const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

function boot(body: string) {
  const win = new Window({ url: `${PAGE}?n=${NONCE}` });
  open.push(win);
  const posted: Array<Record<string, unknown>> = [];
  Object.defineProperty(win, "parent", { value: { postMessage: (m: Record<string, unknown>) => { posted.push(m); } }, configurable: true });
  const tag = htmlPreviewBridgeTag({ nonce: NONCE, gen: GEN, file: "index.html" }).replace(/>[\s\S]*<\/script>$/, "></script>");
  win.document.write(`<!doctype html><html><head>${tag}</head><body>${body}</body></html>`);
  new Function("window", HTML_PREVIEW_BRIDGE_JS)(win);
  const click = (selector: string, init: Record<string, unknown> = {}, type = "click") => {
    const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    win.document.querySelector(selector)!.dispatchEvent(ev);
    return ev;
  };
  const links = () => posted.map(parseChildMessage).filter((m) => m?.type === "open-link").map((m) => (m as { href: string }).href);
  return { win, click, links };
}

describe("HTML preview link hand-off", () => {
  it("hands a new-tab link to the parent and keeps the frame where it is", () => {
    const h = boot(`<a id="jira" href="https://nxsys.atlassian.net/browse/NX-1" target="_blank" rel="noopener">NX-1</a>`);
    const ev = h.click("#jira");
    expect(ev.defaultPrevented).toBe(true);
    expect(h.links()).toEqual(["https://nxsys.atlassian.net/browse/NX-1"]);
  });

  it("hands over a link to another site even without a target", () => {
    const h = boot(`<a id="gh" href="https://github.com/hienlh/ppm/pull/1">PR</a>`);
    expect(h.click("#gh").defaultPrevented).toBe(true);
    expect(h.links()).toEqual(["https://github.com/hienlh/ppm/pull/1"]);
  });

  it("hands over a PPM address opened in a new tab, resolved to a full URL", () => {
    const h = boot(`<a id="chat" href="/project/Nxsys/chat/claude/d9c6812f-8b89-4479-9795-ec7735c5aa6b" target="_blank">chat</a>`);
    h.click("#chat");
    expect(h.links()).toEqual(["http://localhost:3214/project/Nxsys/chat/claude/d9c6812f-8b89-4479-9795-ec7735c5aa6b"]);
  });

  it("lets the frame follow a link to another page of the preview", () => {
    const h = boot(`<a id="next" href="other.html">next</a>`);
    expect(h.click("#next").defaultPrevented).toBe(false);
    expect(h.links()).toEqual([]);
  });

  it("hands over a same-page link opened with Ctrl or the middle button", () => {
    const h = boot(`<a id="next" href="other.html">next</a>`);
    h.click("#next", { ctrlKey: true });
    h.click("#next", { button: 1 }, "auxclick");
    h.click("#next", { button: 2 }, "auxclick");
    expect(h.links()).toEqual([PAGE.replace("index.html", "other.html"), PAGE.replace("index.html", "other.html")]);
  });

  it("leaves a link the page handled itself, and non-web links, alone", () => {
    const h = boot(`<a id="own" href="https://example.com" target="_blank">own</a><a id="mail" href="mailto:a@b.c" target="_blank">mail</a><a id="hash" href="#top">top</a>`);
    h.win.document.addEventListener("click", (e) => { if ((e.target as Element).id === "own") e.preventDefault(); });
    h.click("#own");
    h.click("#mail");
    h.click("#hash");
    expect(h.links()).toEqual([]);
  });
});
