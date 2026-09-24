import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { BRIDGE_JS, bridgeTag } from "../../../src/services/design/bridge/bridge-script.ts";
import { parseChildMessage } from "../../../src/shared/design-bridge-protocol.ts";

/**
 * The move/resize feature, run as the real assembled bridge in a happy-dom window with
 * `window.parent` replaced by a recorder (the harness the picker and tweaks tests use).
 * happy-dom does no layout, so the target's box is stubbed; the handles' hit testing is
 * coordinate maths over that box, the same as in a browser.
 */

const NONCE = "abcdefghijklmnop";
const GEN = "0123456789abcdef";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

function boot() {
  const win = new Window({ url: `http://localhost/api/design-preview/content/tok/home/index.html?n=${NONCE}` });
  open.push(win);
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  Object.defineProperty(win, "parent", { value: parent, configurable: true });
  const tag = bridgeTag({ nonce: NONCE, gen: GEN, cssGens: {}, file: "index.html", instrumented: true })
    .replace(/>[\s\S]*<\/script>$/, "></script>");
  win.document.write(`<!doctype html><html><head>${tag}</head><body><div data-ppm-id="60" id="box">Box</div><p data-ppm-id="90">Other</p></body></html>`);
  new Function("window", BRIDGE_JS)(win);
  const box = win.document.getElementById("box") as unknown as HTMLElement;
  (box as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () =>
    ({ left: 100, top: 100, width: 200, height: 100, right: 300, bottom: 200, x: 100, y: 100 });
  const send = (type: string, extra: Record<string, unknown> = {}) => win.dispatchEvent(new win.MessageEvent("message", {
    data: { ppm: "design-bridge", v: 1, nonce: NONCE, type, ...extra }, source: parent as never,
  }));
  const host = () => win.document.querySelector("ppm-design-handles") as unknown as EventTarget | null;
  const pointer = (type: string, x: number, y: number, target: EventTarget | null = host()) => {
    const ev = new win.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0 });
    target!.dispatchEvent(ev as unknown as Event);
    return ev;
  };
  const key = (k: string, shiftKey = false) =>
    win.document.body.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }) as unknown as Event);
  const commits = () => posted.filter((m) => m.type === "transform-commit").map((m) => parseChildMessage(m));
  const on = () => {
    send("transform-mode", { on: true, scale: 1 });
    send("transform-target", { ppmId: 60, tag: "div" });
  };
  return { win, posted, send, host, pointer, key, commits, box, on };
}

describe("bridge transform", () => {
  it("draws no handles until Move is on with a target that matches its tag", () => {
    const h = boot();
    h.send("transform-target", { ppmId: 60, tag: "div" });
    expect(h.host()).toBeNull();
    h.send("transform-mode", { on: true, scale: 1 });
    expect(h.host()).not.toBeNull();
    h.send("transform-target", { ppmId: 60, tag: "section" });
    h.pointer("pointerdown", 200, 150);
    h.pointer("pointermove", 250, 150);
    h.pointer("pointerup", 250, 150);
    expect(h.commits()).toHaveLength(0);
  });

  it("moves live on drag and proposes translate on release", () => {
    const h = boot();
    h.on();
    h.pointer("pointerdown", 200, 150);
    h.pointer("pointermove", 230, 160);
    expect(h.box.style.getPropertyValue("translate")).toBe("30px 10px");
    h.pointer("pointerup", 230, 160);
    expect(h.commits()).toEqual([{
      type: "transform-commit", nonce: NONCE, file: "index.html", gen: GEN, ppmId: 60, tag: "div", props: { translate: "30px 10px" },
    }]);
  });

  it("resizes from a corner and from the left edge, shifting the offset", () => {
    const h = boot();
    h.on();
    h.pointer("pointerdown", 300, 200);
    h.pointer("pointermove", 320, 230);
    h.pointer("pointerup", 320, 230);
    expect(h.commits()[0]).toMatchObject({ props: { width: "220px", height: "130px" } });
    h.box.style.removeProperty("width");
    h.box.style.removeProperty("height");
    h.pointer("pointerdown", 100, 150);
    h.pointer("pointermove", 110, 150);
    h.pointer("pointerup", 110, 150);
    expect(h.commits()[1]).toMatchObject({ props: { translate: "10px 0px", width: "190px" } });
  });

  it("reverts on pointercancel and on transform-cancel", () => {
    const h = boot();
    h.on();
    h.box.style.setProperty("translate", "5px 5px");
    h.pointer("pointerdown", 200, 150);
    h.pointer("pointermove", 260, 150);
    h.pointer("pointercancel", 260, 150);
    expect(h.box.style.getPropertyValue("translate")).toBe("5px 5px");
    expect(h.commits()).toHaveLength(0);

    h.pointer("pointerdown", 200, 150);
    h.pointer("pointermove", 260, 150);
    h.pointer("pointerup", 260, 150);
    expect(h.box.style.getPropertyValue("translate")).not.toBe("5px 5px");
    h.send("transform-cancel");
    expect(h.box.style.getPropertyValue("translate")).toBe("5px 5px");
  });

  it("keeps every event on the handles from the picker and the page", () => {
    const h = boot();
    h.send("picker", { on: true });
    h.on();
    let pageSaw = 0;
    h.win.document.body.addEventListener("pointerdown", () => { pageSaw++; });
    h.win.document.body.addEventListener("click", () => { pageSaw++; });
    const down = h.pointer("pointerdown", 200, 150);
    h.pointer("pointerup", 200, 150);
    h.host()!.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
    expect(pageSaw).toBe(0);
    expect(down.defaultPrevented).toBe(true);
    expect(h.posted.filter((m) => m.type === "select" || m.type === "element-menu")).toHaveLength(0);
  });

  it("coalesces arrow keys into one proposal 500 ms after the last, and Esc drops a pending one", async () => {
    const h = boot();
    h.on();
    h.key("ArrowRight");
    h.key("ArrowRight");
    h.key("ArrowDown", true);
    expect(h.box.style.getPropertyValue("translate")).toBe("2px 10px");
    expect(h.commits()).toHaveLength(0);
    await sleep(650);
    expect(h.commits()).toEqual([expect.objectContaining({ props: { translate: "2px 10px" } })]);

    h.key("ArrowLeft");
    h.key("Escape");
    await sleep(650);
    expect(h.commits()).toHaveLength(1);
    expect(h.box.style.getPropertyValue("translate")).toBe("2px 10px");
  });

  it("applies nudges forwarded by the parent", async () => {
    const h = boot();
    h.on();
    h.send("transform-nudge", { dx: -10, dy: 0 });
    await sleep(650);
    expect(h.commits()).toEqual([expect.objectContaining({ props: { translate: "-10px 0px" } })]);
  });

  it("lets the page have its events again once Move is off", () => {
    const h = boot();
    h.on();
    h.send("transform-mode", { on: false, scale: 1 });
    let pageSaw = 0;
    h.box.addEventListener("pointerdown", () => { pageSaw++; });
    h.pointer("pointerdown", 200, 150, h.box as unknown as EventTarget);
    expect(pageSaw).toBe(1);
    expect(h.commits()).toHaveLength(0);
  });
});
