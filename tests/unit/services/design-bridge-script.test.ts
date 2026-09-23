import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { assembleBridge, BRIDGE_FEATURES, BRIDGE_JS, bridgeTag } from "../../../src/services/design/bridge/bridge-script.ts";
import { installNavGuard } from "../../../src/services/design/bridge/bridge-nav-guard.ts";
import { parseChildMessage } from "../../../src/shared/design-bridge-protocol.ts";

/**
 * The bridge runs in a happy-dom window of its own (no globals installed), fed the exact
 * assembled source the server injects, with `window.parent` replaced by a recorder.
 */

const NONCE = "abcdefghijklmnop";
const GEN = "0123456789abcdef";
const URL_BASE = "http://localhost:8080/api/design-preview/content/tok/landing/index.html";

interface Harness {
  win: Window;
  posted: Array<Record<string, unknown>>;
  parent: { postMessage(message: Record<string, unknown>, origin: string): void };
  send(data: Record<string, unknown>, source?: unknown): void;
}

const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

function boot(body: string, opts: { nonce?: string | null; navigation?: EventTarget } = {}): Harness {
  const nonce = opts.nonce === undefined ? NONCE : opts.nonce;
  const win = new Window({ url: `${URL_BASE}?n=${nonce ?? ""}` });
  open.push(win);
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (message: Record<string, unknown>) => { posted.push(message); } };
  Object.defineProperty(win, "parent", { value: parent, configurable: true });
  if (opts.navigation) Object.defineProperty(win, "navigation", { value: opts.navigation, configurable: true });
  // The tag's attributes as the server writes them, with the body left out: the script is
  // run below through `new Function`, which is also the parse check.
  const tag = bridgeTag({ nonce, gen: GEN, cssGens: { "styles.css": "fedcba9876543210" }, file: "index.html", instrumented: true })
    .replace(/>[\s\S]*<\/script>$/, "></script>");
  win.document.write(`<!doctype html><html><head>${tag}<title>Deck</title></head><body>${body}</body></html>`);
  new Function("window", BRIDGE_JS)(win);
  const send = (data: Record<string, unknown>, source: unknown = parent): void => {
    win.dispatchEvent(new win.MessageEvent("message", { data, source: source as never }));
  };
  return { win, posted, parent, send };
}

const ofType = (h: Harness, type: string) => h.posted.filter((m) => m.type === type);

describe("bridge assembly", () => {
  it("parses as a script and cannot break out of its <script> element", () => {
    expect(() => new Function("window", BRIDGE_JS)).not.toThrow();
    expect(BRIDGE_JS).not.toMatch(/<\/script|<!--|<script/i);
    expect(BRIDGE_FEATURES).toContain(installNavGuard);
  });

  it("runs features through the array, so a failing one is reported and the rest still run", () => {
    const js = assembleBridge([
      () => { throw new Error("boom"); },
      (ppm) => { ppm.post("probe", { ok: true }); },
    ]);
    const win = new Window({ url: URL_BASE });
    open.push(win);
    const posted: Array<Record<string, unknown>> = [];
    Object.defineProperty(win, "parent", { value: { postMessage: (m: Record<string, unknown>) => posted.push(m) } });
    new Function("window", js)(win);
    expect(posted.map((m) => m.type)).toEqual(["issue", "probe", "ready"]);
    expect(posted[0]!.message).toContain("boom");
  });

  it("escapes every attribute value it writes", () => {
    const tag = bridgeTag({ nonce: null, gen: GEN, cssGens: { "a\"b.css": GEN }, file: "x\"><img src=x onerror=1>.html", instrumented: false });
    const head = tag.slice(0, tag.indexOf(">") + 1);
    expect(head).not.toContain("<img");
    expect(head).toContain('data-instrumented="0"');
    expect(head).toContain("&quot;");
  });
});

describe("bridge core", () => {
  it("posts ready with the load's nonce, gen, css gens and file, and removes its own script", () => {
    const h = boot("<p data-ppm-id=\"40\">x</p>");
    const [ready] = ofType(h, "ready");
    expect(ready).toMatchObject({
      ppm: "design-bridge", v: 1, nonce: NONCE, gen: GEN, cssGens: { "styles.css": "fedcba9876543210" },
      file: "index.html", instrumented: true, title: "Deck",
    });
    expect(parseChildMessage(ready)).toMatchObject({ type: "ready", nonce: NONCE });
    expect(h.win.document.querySelector("script[data-ppm-bridge]")).toBeNull();
  });

  it("posts nonce: null when the URL carried no valid nonce, which the parent rejects", () => {
    const h = boot("", { nonce: null });
    expect(ofType(h, "ready")[0]!.nonce).toBeNull();
  });

  it("applies restore-scroll from the parent and ignores it from anyone else", () => {
    const h = boot("<div style=\"height:5000px\"></div>");
    const msg = { ppm: "design-bridge", v: 1, nonce: NONCE, type: "restore-scroll", x: 0, y: 300 };
    h.send(msg, h.win);
    h.send(msg, { postMessage() {} });
    h.send({ ...msg, nonce: "zzzzzzzzzzzzzzzz" });
    h.send({ ...msg, ppm: "other" });
    expect(h.win.scrollY).toBe(0);
    h.send(msg);
    expect(h.win.scrollY).toBe(300);
  });

  it("finds elements by data-ppm-id and nothing else", () => {
    // A feature is shipped as source, so it cannot close over a test variable; it hands
    // the api out through the window it runs in.
    const js = assembleBridge([(ppm) => { (ppm.win as unknown as Record<string, unknown>).__bridgeApi = ppm; }]);
    const win = new Window({ url: URL_BASE });
    open.push(win);
    Object.defineProperty(win, "parent", { value: { postMessage() {} } });
    win.document.write("<p data-ppm-id=\"12\" id=\"p\">x</p>");
    new Function("window", js)(win);
    const api = (win as unknown as Record<string, { byId(id: unknown): unknown }>).__bridgeApi!;
    expect(api.byId(12)).toBe(win.document.getElementById("p"));
    for (const bad of ["12", 1.5, -1, null, "\"] , *"]) expect(api.byId(bad)).toBeNull();
  });

  it("reports errors, capped at 20 per load", () => {
    const h = boot("");
    for (let i = 0; i < 30; i++) {
      h.win.dispatchEvent(new h.win.ErrorEvent("error", { message: `boom ${i}`, filename: "app.js", lineno: i }));
    }
    const issues = ofType(h, "issue");
    expect(issues).toHaveLength(20);
    expect(parseChildMessage(issues[0])).toMatchObject({ type: "issue", kind: "error", message: "boom 0", source: "app.js" });
  });
});

describe("navigation guard", () => {
  const click = (h: Harness, id: string, type = "click"): boolean => {
    const event = new h.win.MouseEvent(type, { bubbles: true, cancelable: true });
    h.win.document.getElementById(id)!.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("blocks a link out of the document and reports it", () => {
    const h = boot("<a id=\"ext\" href=\"https://evil.example/?d=secret\"><span id=\"inner\">go</span></a><a id=\"rel\" href=\"other.html\">x</a>");
    expect(click(h, "inner")).toBe(true);
    expect(click(h, "rel")).toBe(true);
    expect(click(h, "ext", "auxclick")).toBe(true);
    const blocked = ofType(h, "navigate-blocked").map((m) => parseChildMessage(m));
    expect(blocked).toEqual([
      { type: "navigate-blocked", href: "https://evil.example/?d=secret", nonce: NONCE },
      { type: "navigate-blocked", href: "http://localhost:8080/api/design-preview/content/tok/landing/other.html", nonce: NONCE },
      { type: "navigate-blocked", href: "https://evil.example/?d=secret", nonce: NONCE },
    ]);
  });

  it("lets in-page anchors through and swallows javascript: links quietly", () => {
    const h = boot("<a id=\"hash\" href=\"#pricing\">p</a><a id=\"js\" href=\"javascript:void(0)\">j</a><section id=\"pricing\"></section>");
    expect(click(h, "hash")).toBe(false);
    expect(click(h, "js")).toBe(true);
    expect(ofType(h, "navigate-blocked")).toHaveLength(0);
  });

  it("cancels a cross-document navigate event where the Navigation API exists", () => {
    const navigation = new EventTarget();
    const h = boot("", { navigation });
    const navigate = (init: { url: string; sameDocument?: boolean; hashChange?: boolean; cancelable?: boolean }): boolean => {
      const event = Object.assign(new Event("navigate", { cancelable: init.cancelable ?? true }), {
        hashChange: init.hashChange ?? false, destination: { url: init.url, sameDocument: init.sameDocument ?? false },
      });
      navigation.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(navigate({ url: "https://evil.example/?d=1" })).toBe(true);
    expect(navigate({ url: `${URL_BASE}?n=${NONCE}` })).toBe(false);
    expect(navigate({ url: `${URL_BASE}#x`, sameDocument: true, hashChange: true })).toBe(false);
    expect(navigate({ url: "https://parent-initiated.example/", cancelable: false })).toBe(false);
    expect(ofType(h, "navigate-blocked").map((m) => m.href)).toEqual(["https://evil.example/?d=1"]);
  });
});
