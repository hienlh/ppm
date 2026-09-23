import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { BRIDGE_JS, bridgeTag } from "../../../src/services/design/bridge/bridge-script.ts";
import { parseChildMessage } from "../../../src/shared/design-bridge-protocol.ts";
import { TWEAK_INJECTIONS } from "../../fixtures/design-tweak-injections.ts";

/**
 * The tweaks feature, run as the real assembled bridge in a happy-dom window with
 * `window.parent` replaced by a recorder (the same harness as the picker's test). Messages
 * are dispatched straight at the frame, so the in-frame checks are exercised on their own,
 * without the parent-side validation in front of them.
 */

const NONCE = "abcdefghijklmnop";
const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

function boot(head: string) {
  const win = new Window({ url: `http://localhost/api/design-preview/content/tok/home/index.html?n=${NONCE}` });
  open.push(win);
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  Object.defineProperty(win, "parent", { value: parent, configurable: true });
  const tag = bridgeTag({ nonce: NONCE, gen: "0123456789abcdef", cssGens: {}, file: "index.html", instrumented: true })
    .replace(/>[\s\S]*<\/script>$/, "></script>");
  win.document.write(`<!doctype html><html><head>${tag}${head}</head><body><p>x</p></body></html>`);
  new Function("window", BRIDGE_JS)(win);
  const send = (type: string, extra: Record<string, unknown> = {}) => win.dispatchEvent(new win.MessageEvent("message", {
    data: { ppm: "design-bridge", v: 1, nonce: NONCE, type, ...extra }, source: parent as never,
  }));
  const root = () => win.document.documentElement.style;
  const lastValues = () => {
    const m = [...posted].reverse().find((p) => p.type === "tweak-values");
    return m ? parseChildMessage(m) : null;
  };
  return { win, posted, send, root, lastValues };
}

describe("bridge tweaks", () => {
  it("sets live values as important inline overrides and resets them", () => {
    const h = boot("<style>:root { --accent: #111111; --radius: 4px }</style>");
    h.send("tweak-set", { values: { "--accent": "#6366f1", "--radius": "12px" } });
    expect(h.root().getPropertyValue("--accent")).toBe("#6366f1");
    expect(h.root().getPropertyPriority("--accent")).toBe("important");
    h.send("tweak-reset", { vars: ["--radius"] });
    expect(h.root().getPropertyValue("--radius")).toBe("");
    expect(h.root().getPropertyValue("--accent")).toBe("#6366f1");
    h.send("tweak-reset");
    expect(h.root().getPropertyValue("--accent")).toBe("");
  });

  it("never lets a malformed name or value reach setProperty", () => {
    const h = boot("");
    for (const value of TWEAK_INJECTIONS) h.send("tweak-set", { values: { "--accent": value } });
    h.send("tweak-set", { values: { color: "red", "--ok": "1px", "--x;": "1px" } });
    h.send("tweak-set", { values: "--accent" });
    expect(h.root().getPropertyValue("--accent")).toBe("");
    expect(h.root().getPropertyValue("color")).toBe("");
    expect(h.root().getPropertyValue("--ok")).toBe("1px");
    // A reset cannot be used to strip a property the bridge did not set.
    h.root().setProperty("--page-own", "3px");
    h.send("tweak-reset", { vars: ["--page-own"] });
    expect(h.root().getPropertyValue("--page-own")).toBe("3px");
  });

  it("reads rendered values and which kind of rule sets each one last", () => {
    const h = boot("<style>:root { --accent: #111111 } .x { --other: 1px } @media (min-width: 1px) { :root { --dark: #000 } }</style>");
    h.send("tweak-read", { vars: ["--accent", "--other", "--dark", "--none", "bad"] });
    const answer = h.lastValues();
    expect(answer).not.toBeNull();
    const { values, winners } = answer as unknown as { values: Record<string, string>; winners: Record<string, string> };
    expect(Object.keys(values)).toEqual(["--accent", "--other", "--dark", "--none"]);
    expect(values["--accent"]).toBe("#111111");
    expect(values["--none"]).toBe("");
    expect(winners).toEqual({ "--accent": "root", "--other": "other", "--dark": "conditional", "--none": "unknown" });
  });

  it("reads the live override once one is set", () => {
    const h = boot("<style>:root { --accent: #111111 }</style>");
    h.send("tweak-set", { values: { "--accent": "#222222" } });
    h.send("tweak-read", { vars: ["--accent"] });
    expect((h.lastValues() as { values: Record<string, string> }).values["--accent"]).toBe("#222222");
  });
});
