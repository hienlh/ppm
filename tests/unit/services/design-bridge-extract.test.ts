import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { extractTextRuns, mergeTextRuns, parseCssColor } from "../../../src/services/design/bridge/bridge-extract-text.ts";
import { cssRotation } from "../../../src/services/design/bridge/bridge-extract-blocks.ts";
import { BRIDGE_JS, bridgeTag } from "../../../src/services/design/bridge/bridge-script.ts";

/**
 * The pure pieces of the PowerPoint measuring pass. Positions need a real layout engine
 * (happy-dom has none), so geometry is proven in the browser; here: colours, runs,
 * whitespace, rotation, and the message round trip.
 */

const open: Window[] = [];
afterEach(async () => {
  for (const win of open.splice(0)) await win.happyDOM.close();
});

describe("parseCssColor", () => {
  it("reads computed rgb()/rgba() in both syntaxes, hex and transparent", () => {
    expect(parseCssColor("rgb(255, 0, 16)")).toEqual({ hex: "FF0010", alpha: 1 });
    expect(parseCssColor("rgba(0, 128, 255, 0.5)")).toEqual({ hex: "0080FF", alpha: 0.5 });
    expect(parseCssColor("rgb(10 20 30 / 25%)")).toEqual({ hex: "0A141E", alpha: 0.25 });
    expect(parseCssColor("rgb(100%, 0%, 0%)")).toEqual({ hex: "FF0000", alpha: 1 });
    expect(parseCssColor("#abc")).toEqual({ hex: "AABBCC", alpha: 1 });
    expect(parseCssColor("#11223380")).toEqual({ hex: "112233", alpha: 0.502 });
    expect(parseCssColor("transparent")).toEqual({ hex: "000000", alpha: 0 });
  });

  it("answers null for what only a canvas can convert, and for junk", () => {
    for (const v of ["oklch(0.7 0.1 200)", "color(srgb 1 0 0)", "red", "", "rgb(1,2)", "#12345"]) expect(parseCssColor(v)).toBeNull();
  });
});

describe("mergeTextRuns", () => {
  it("joins same-style neighbours, folds bare breaks and trims line edges", () => {
    expect(mergeTextRuns([
      { text: " Hello ", bold: true }, { text: "big ", bold: true }, { text: "world ", italic: true },
      { text: "", breakLine: true }, { text: " next", sizePx: 10 }, { text: "", breakLine: true }, { text: "" },
    ])).toEqual([
      { text: "Hello big ", bold: true }, { text: "world", italic: true, breakLine: true }, { text: "next", sizePx: 10 },
    ]);
  });

  it("keeps an empty line between two breaks and never merges across a break", () => {
    expect(mergeTextRuns([{ text: "a" }, { text: "", breakLine: true }, { text: "", breakLine: true }, { text: "b" }]))
      .toEqual([{ text: "a", breakLine: true }, { text: "", breakLine: true }, { text: "b" }]);
    const color = { hex: "FF0000", alpha: 1 };
    expect(mergeTextRuns([{ text: "a", color }, { text: "b", color: { ...color } }])).toEqual([{ text: "ab", color }]);
    expect(mergeTextRuns([{ text: "a", color }, { text: "b" }])).toHaveLength(2);
  });
});

describe("extractTextRuns", () => {
  it("collapses whitespace, styles inline runs, honours <br> and skips nested blocks", () => {
    const win = new Window();
    open.push(win);
    win.document.body.innerHTML = "<p id=p style=\"font-size:20px;color:rgb(0,0,255)\">\n  Hello   <b style=\"font-weight:700\">bold</b> <u style=\"text-decoration-line:underline\">line</u><br><i style=\"font-style:italic\">next</i><span style=\"display:block\">block</span><script>x</script></p>";
    const el = win.document.getElementById("p") as unknown as Element;
    const notes: string[] = [];
    const runs = mergeTextRuns(extractTextRuns(el, win as unknown as Window, parseCssColor, (l) => notes.push(l)));
    expect(runs.map((r) => r.text)).toEqual(["Hello ", "bold", " ", "line", "next"]);
    expect(runs[1]).toMatchObject({ bold: true, sizePx: 20, color: { hex: "0000FF", alpha: 1 } });
    expect(runs[3]).toMatchObject({ underline: true, breakLine: true });
    expect(runs[4]).toMatchObject({ italic: true });
    expect(notes).toEqual([]);
  });
});

describe("cssRotation", () => {
  const cs = (transform: string, rotate = "none", scale = "none") => ({ transform, rotate, scale }) as unknown as CSSStyleDeclaration;
  it("reads a pure rotation from the matrix and the rotate property", () => {
    const r = Math.SQRT1_2;
    expect(cssRotation(cs(`matrix(${r}, ${r}, ${-r}, ${r}, 10, 20)`))).toEqual({ deg: 45, pure: true });
    expect(cssRotation(cs("none", "-90deg"))).toEqual({ deg: 270, pure: true });
    expect(cssRotation(cs("none"))).toEqual({ deg: 0, pure: true });
  });
  it("flags scale, skew, 3D and axis rotations as not carried over", () => {
    expect(cssRotation(cs("matrix(2, 0, 0, 2, 0, 0)")).pure).toBe(false);
    expect(cssRotation(cs("matrix(1, 0, 0.5, 1, 0, 0)")).pure).toBe(false);
    expect(cssRotation(cs("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)")).pure).toBe(false);
    expect(cssRotation(cs("none", "x 45deg")).pure).toBe(false);
    expect(cssRotation(cs("none", "none", "1.5")).pure).toBe(false);
  });
});

describe("slides-extract in the bridge", () => {
  it("answers with the request id it was asked with, and only to the parent", async () => {
    const win = new Window({ url: "http://localhost/api/design-preview/content/t/deck/index.html" });
    open.push(win);
    const posted: Array<Record<string, unknown>> = [];
    const parent = { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
    Object.defineProperty(win, "parent", { value: parent, configurable: true });
    const tag = bridgeTag({ nonce: "abcdefghijklmnop", gen: "0123456789abcdef", cssGens: {}, file: "index.html", instrumented: true })
      .replace(/>[\s\S]*<\/script>$/, "></script>");
    win.document.write(`<!doctype html><html><head>${tag}</head><body><section class="slide"><h1>One</h1></section></body></html>`);
    new Function("window", BRIDGE_JS)(win);
    const send = (data: Record<string, unknown>, source: unknown = parent) =>
      win.dispatchEvent(new win.MessageEvent("message", { data, source: source as never }));
    const envelope = { ppm: "design-bridge", v: 1, nonce: "abcdefghijklmnop", type: "slides-extract", requestId: "req_0123456789" };
    send(envelope, {});
    send({ ...envelope, requestId: "bad id" });
    send(envelope);
    await new Promise((r) => setTimeout(r, 50));
    const answers = posted.filter((m) => m.type === "slides-data" || m.type === "slides-error");
    // happy-dom lays nothing out, so the deck has no size: an error, but for this request.
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ type: "slides-error", requestId: "req_0123456789", message: "The slides have no size on the canvas" });
  });
});
