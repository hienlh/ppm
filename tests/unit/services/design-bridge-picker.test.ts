import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { BRIDGE_JS, bridgeTag } from "../../../src/services/design/bridge/bridge-script.ts";
import { parseChildMessage } from "../../../src/shared/design-bridge-protocol.ts";

/**
 * The picker and pins features, run as the real assembled bridge in a happy-dom window of
 * its own, with `window.parent` replaced by a recorder (same harness as the core's test).
 */

const NONCE = "abcdefghijklmnop";
const GEN = "0123456789abcdef";
const URL_BASE = "http://localhost:8080/api/design-preview/content/tok/landing/index.html";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  win: Window;
  posted: Array<Record<string, unknown>>;
  send(type: string, body?: Record<string, unknown>): void;
  el(selector: string): Element;
}

const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

function boot(body: string): Harness {
  const win = new Window({ url: `${URL_BASE}?n=${NONCE}` });
  open.push(win);
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  Object.defineProperty(win, "parent", { value: parent, configurable: true });
  const tag = bridgeTag({ nonce: NONCE, gen: GEN, cssGens: {}, file: "index.html", instrumented: true })
    .replace(/>[\s\S]*<\/script>$/, "></script>");
  win.document.write(`<!doctype html><html><head>${tag}</head><body>${body}</body></html>`);
  new Function("window", BRIDGE_JS)(win);
  return {
    win,
    posted,
    send: (type, extra = {}) => win.dispatchEvent(new win.MessageEvent("message", {
      data: { ppm: "design-bridge", v: 1, nonce: NONCE, type, ...extra }, source: parent as never,
    })),
    el: (selector) => win.document.querySelector(selector) as unknown as Element,
  };
}

const ofType = (h: Harness, type: string) => h.posted.filter((m) => m.type === type);

function click(h: Harness, target: Element): Event {
  const ev = new h.win.MouseEvent("click", { bubbles: true, cancelable: true });
  (target as unknown as EventTarget).dispatchEvent(ev as unknown as Event);
  return ev as unknown as Event;
}

/** A touch event whose `touches` is set directly, so the test needs no Touch constructor. */
function touch(h: Harness, target: Element, type: string, x = 5, y = 5): void {
  const ev = new h.win.Event(type, { bubbles: true, cancelable: true });
  const touches = type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y, target }];
  Object.defineProperty(ev, "touches", { value: touches });
  (target as unknown as EventTarget).dispatchEvent(ev as unknown as Event);
}

function tap(h: Harness, target: Element): void {
  touch(h, target, "touchstart");
  touch(h, target, "touchend");
  click(h, target);
}

const PAGE = '<main data-ppm-id="60"><h1 data-ppm-id="70">Title</h1><p data-ppm-id="90" id="lead">Pricing <a data-ppm-id="110" href="https://example.com/x">starts</a> here</p><p data-ppm-id="200">Other</p></main>';

describe("picker", () => {
  it("does nothing while off: clicks reach the page and links are still guarded", () => {
    const h = boot(PAGE);
    let reached = false;
    h.el("h1").addEventListener("click", () => { reached = true; });
    click(h, h.el("h1"));
    expect(reached).toBe(true);
    expect(ofType(h, "select")).toHaveLength(0);
    click(h, h.el("a"));
    expect(ofType(h, "navigate-blocked")).toHaveLength(1);
  });

  it("outlines on hover and selects on click, swallowing the click before the page and the nav guard", () => {
    const h = boot(PAGE);
    h.send("picker", { on: true });
    let reached = false;
    h.el("a").addEventListener("click", () => { reached = true; });
    h.el("a").dispatchEvent(new h.win.MouseEvent("mousemove", { bubbles: true }) as unknown as Event);
    expect(ofType(h, "hover").at(-1)).toMatchObject({ el: { tag: "a" } });
    const ev = click(h, h.el("a"));
    expect(ev.defaultPrevented).toBe(true);
    expect(reached).toBe(false);
    expect(ofType(h, "navigate-blocked")).toHaveLength(0);
    const [select] = ofType(h, "select");
    const parsed = parseChildMessage(select);
    expect(parsed).toMatchObject({ type: "select", nonce: NONCE, el: { ppmId: 110, gen: GEN, file: "index.html", tag: "a", quote: { exact: "starts", prefix: "Title Pricing", suffix: "here Other" } } });
    expect(parsed && parsed.type === "select" && parsed.el.cssPath).toBe("#lead > a:nth-of-type(1)");
    expect(parsed && parsed.type === "select" && parsed.el.outerHtml).toBe('<a href="https://example.com/x">starts</a>');
  });

  it("draws its outline in a closed shadow root that is not part of the page's body", () => {
    const h = boot(PAGE);
    h.send("picker", { on: true });
    click(h, h.el("h1"));
    const host = h.win.document.querySelector("ppm-design-overlay");
    expect(host).not.toBeNull();
    expect(host!.parentElement).toBe(h.win.document.documentElement);
    expect((host as unknown as { shadowRoot: unknown }).shadowRoot).toBeNull();
    expect(h.win.document.body.innerHTML).not.toContain("ppm-design-overlay");
  });

  it("on touch, outlines on the first tap and selects on a second tap of the same element", () => {
    const h = boot(PAGE);
    h.send("picker", { on: true });
    tap(h, h.el("h1"));
    expect(ofType(h, "select")).toHaveLength(0);
    expect(ofType(h, "hover").at(-1)).toMatchObject({ el: { tag: "h1" } });
    tap(h, h.el("p"));
    expect(ofType(h, "select")).toHaveLength(0);
    expect(ofType(h, "hover").at(-1)).toMatchObject({ el: { tag: "p" } });
    tap(h, h.el("p"));
    expect(ofType(h, "select")).toHaveLength(1);
    expect(ofType(h, "select")[0]).toMatchObject({ el: { tag: "p", ppmId: 90 } });
  });

  it("selects and asks for the composer on a long-press, and eats the click that follows", async () => {
    const h = boot(PAGE);
    h.send("picker", { on: true });
    touch(h, h.el("h1"), "touchstart");
    await sleep(600);
    expect(ofType(h, "element-menu")).toHaveLength(1);
    expect(ofType(h, "element-menu")[0]).toMatchObject({ el: { tag: "h1" } });
    touch(h, h.el("h1"), "touchend");
    click(h, h.el("h1"));
    expect(ofType(h, "select")).toHaveLength(0);
    expect(ofType(h, "hover").filter((m) => m.el)).toHaveLength(0);
  });

  it("never opens the composer when the browser cancels the touch for a scroll", async () => {
    const h = boot(PAGE);
    h.send("picker", { on: true });
    touch(h, h.el("h1"), "touchstart");
    touch(h, h.el("h1"), "touchcancel");
    await sleep(600);
    expect(ofType(h, "element-menu")).toHaveLength(0);
  });

  it("never opens the composer once the finger has moved past the tolerance", async () => {
    const h = boot(PAGE);
    h.send("picker", { on: true });
    touch(h, h.el("h1"), "touchstart", 5, 5);
    touch(h, h.el("h1"), "touchmove", 25, 5);
    await sleep(600);
    expect(ofType(h, "element-menu")).toHaveLength(0);
  });

  it("exits on Esc and lets clicks through again", () => {
    const h = boot(PAGE);
    h.send("picker", { on: true });
    h.win.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Escape", cancelable: true }) as unknown as Event);
    expect(ofType(h, "picker-exit")).toHaveLength(1);
    let reached = false;
    h.el("h1").addEventListener("click", () => { reached = true; });
    click(h, h.el("h1"));
    expect(reached).toBe(true);
  });

  it("selects the parent on request, but never <html>", () => {
    const h = boot(PAGE);
    h.send("picker", { on: true });
    click(h, h.el("a"));
    h.send("select-parent");
    h.send("select-parent");
    h.send("select-parent");
    h.send("select-parent");
    expect(ofType(h, "select").map((m) => (m.el as { tag: string }).tag)).toEqual(["a", "p", "main", "body"]);
    h.send("clear-selection");
    h.send("select-parent");
    expect(ofType(h, "select")).toHaveLength(4);
  });
});

describe("pins", () => {
  const quote = (exact: string, prefix = "", suffix = "") => ({ exact, prefix, suffix });
  const anchor = (over: Record<string, unknown>) => ({ file: "index.html", ppmId: 90, gen: GEN, tag: "p", cssPath: "", quote: quote("x"), ...over });

  it("reports rects for exact pins, a re-anchor with the new id, and null for an orphan", async () => {
    const h = boot(PAGE);
    h.send("pins-set", {
      pins: [
        { id: "000000000001", anchor: anchor({}) },
        { id: "000000000002", anchor: anchor({ ppmId: 90, gen: "ffffffffffffffff", quote: quote("Other", "Pricing starts here") }) },
        { id: "000000000003", anchor: anchor({ ppmId: 5, gen: "ffffffffffffffff", quote: quote("Gone forever and ever") }) },
      ],
    });
    await sleep(50);
    const [report] = ofType(h, "pins-rects");
    const parsed = parseChildMessage(report);
    expect(parsed).toMatchObject({
      type: "pins-rects",
      pins: [
        { id: "000000000001", ppmId: 90, gen: GEN, reanchored: false },
        { id: "000000000002", ppmId: 200, gen: GEN, reanchored: true },
        { id: "000000000003", rect: null, reanchored: false },
      ],
    });
    const pins = (parsed as { pins: Array<{ rect: unknown }> }).pins;
    expect(pins[0]!.rect).not.toBeNull();
  });

  it("re-reports when a pinned element leaves the DOM", async () => {
    const h = boot(PAGE);
    h.send("pins-set", { pins: [{ id: "000000000001", anchor: anchor({ ppmId: 200, quote: quote("Other") }) }] });
    await sleep(50);
    expect(ofType(h, "pins-rects").at(-1)).toMatchObject({ pins: [{ rect: { x: 0 } }] });
    h.el('[data-ppm-id="200"]').remove();
    await sleep(450);
    expect(ofType(h, "pins-rects").at(-1)).toMatchObject({ pins: [{ id: "000000000001", rect: null }] });
  });

  it("answers an empty set at once", () => {
    const h = boot(PAGE);
    h.send("pins-set", { pins: [] });
    expect(ofType(h, "pins-rects").at(-1)).toMatchObject({ pins: [] });
  });
});
