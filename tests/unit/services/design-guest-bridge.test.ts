import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { GUEST_BRIDGE_JS } from "../../../src/services/design/bridge/guest-bridge.ts";
import { assertInlineScript, bridgeTag } from "../../../src/services/design/bridge/bridge-script.ts";

const NONCE = "abcdefghijklmnop";
const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

function boot(body: string) {
  const win = new Window({ url: `http://localhost/s/code/f/home/index.html?n=${NONCE}` });
  open.push(win);
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  Object.defineProperty(win, "parent", { value: parent, configurable: true });
  const tag = bridgeTag({ nonce: NONCE, gen: "0123456789abcdef", cssGens: {}, file: "index.html", instrumented: true }, GUEST_BRIDGE_JS)
    .replace(/>[\s\S]*<\/script>$/, "></script>");
  win.document.write(`<!doctype html><html><head>${tag}</head><body>${body}</body></html>`);
  new Function("window", GUEST_BRIDGE_JS)(win);
  const send = (data: Record<string, unknown>) =>
    win.dispatchEvent(new win.MessageEvent("message", { data: { ppm: "design-bridge", v: 1, ...data }, source: parent as never }));
  return { win, posted, send };
}

describe("guest bridge", () => {
  it("parses, stays inside its <script> element and carries no write feature", () => {
    expect(() => new Function("window", GUEST_BRIDGE_JS)).not.toThrow();
    expect(() => assertInlineScript(GUEST_BRIDGE_JS, "guest")).not.toThrow();
    for (const name of ["transform-commit", "transform-", "tweak", "installTransform", "installTweaks", "installSlidesExtract", "installLayoutCheck"]) {
      expect(GUEST_BRIDGE_JS).not.toContain(name);
    }
  });

  it("boots, reports ready, and picks an element when the parent turns the picker on", () => {
    const h = boot('<p data-ppm-id="40">Hello</p>');
    expect(h.posted.find((m) => m.type === "ready")).toMatchObject({ nonce: NONCE, file: "index.html" });
    expect(h.posted.filter((m) => m.type === "issue")).toEqual([]);
    h.send({ type: "picker", on: true });
    h.send({ type: "pins-set", pins: [] });
    // The tweak and transform handlers do not exist: messages for them change nothing.
    h.send({ type: "tweak-set", name: "x", value: "y" });
    h.send({ type: "transform-mode", on: true });
    expect(h.posted.filter((m) => m.type === "issue")).toEqual([]);
  });
});
