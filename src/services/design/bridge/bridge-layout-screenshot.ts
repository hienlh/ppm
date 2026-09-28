import type { BridgeApi } from "./bridge-core.ts";

/**
 * The picture half of the canvas self-check, drawn inside the design frame by the screenshot
 * library the parent handed over (`modern-screenshot`, which re-renders the DOM through an
 * SVG `foreignObject`). No headless browser is involved: the canvas the user has open is
 * the renderer.
 *
 * The result is at most 1280px wide and 2400px tall and at most 400 KB, as a JPEG: quality
 * drops first, then the size. Web fonts and images from CDNs may come out substituted,
 * because the frame may fetch its own design files only; the note says so. Shipped as source
 * (`ppm.lib`), so nothing here may reference this module's scope.
 */

export interface ScreenshotLib {
  createContext(node: Node, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  domToCanvas(context: Record<string, unknown>): Promise<HTMLCanvasElement>;
  destroyContext(context: Record<string, unknown>): void;
}

export interface CanvasShot {
  dataUrl: string;
  width: number;
  height: number;
  note: string;
}

export async function captureScreenshot(ppm: BridgeApi, shot: ScreenshotLib): Promise<CanvasShot> {
  const win = ppm.win;
  const doc = ppm.doc;
  const de = doc.documentElement;
  const MAX_W = 1280, MAX_H = 2400, MAX_BYTES = 400 * 1024;
  const width = de.clientWidth || win.innerWidth;
  const scale = Math.min(1, MAX_W / Math.max(1, width));
  const paint = (el: Element): string => win.getComputedStyle(el).backgroundColor;
  const clear = (c: string): boolean => !c || c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);
  const bg = !clear(paint(de)) ? paint(de) : doc.body && !clear(paint(doc.body)) ? paint(doc.body) : "#ffffff";
  // The copy is styled with resolved values, and for a grid container those list implicit
  // tracks as if they were explicit, which moves every `-1` line and re-places the items:
  // the broken grid this check exists for would come out as a different layout. So each
  // grid's authored template (Typed OM, where available) rides along on an attribute and is
  // put back on the copy.
  const MARK = "data-ppm-shot-grid";
  const marked: Element[] = [];
  const all = doc.body ? doc.body.getElementsByTagName("*") : [];
  for (let i = 0; i < all.length && i < 8000; i++) {
    const el = all[i] as Element & { computedStyleMap?: () => { get(name: string): unknown } };
    if (typeof el.computedStyleMap !== "function") break;
    const d = win.getComputedStyle(el).display;
    if (d !== "grid" && d !== "inline-grid") continue;
    const map = el.computedStyleMap();
    el.setAttribute(MARK, String(map.get("grid-template-columns")) + "|" + String(map.get("grid-template-rows")));
    marked.push(el);
  }
  const restoreTemplate = (clone: Node): void => {
    const c = clone as HTMLElement;
    if (c.nodeType !== 1 || !c.hasAttribute(MARK)) return;
    const parts = (c.getAttribute(MARK) || "").split("|");
    c.removeAttribute(MARK);
    if (parts[0] && parts[0] !== "none") c.style.setProperty("grid-template-columns", parts[0]);
    if (parts[1] && parts[1] !== "none") c.style.setProperty("grid-template-rows", parts[1]);
  };
  let rendered: HTMLCanvasElement;
  try {
    const context = await shot.createContext(de, {
      scale, backgroundColor: bg, timeout: 6000, onCloneEachNode: restoreTemplate,
      filter: (node: Node) => !((node as Element).localName && /^ppm-design-/.test((node as Element).localName)),
    });
    // The library reads default styles from a hidden iframe of its own. Inside the sandboxed
    // design every nested frame gets a fresh opaque origin, so reading that iframe throws a
    // cross-origin error; a stand-in with no window makes it inline every computed style
    // instead (a larger SVG, the same picture).
    context.sandbox = { contentWindow: null, remove() { /* nothing was attached */ } };
    try {
      rendered = await shot.domToCanvas(context);
    } finally {
      try { shot.destroyContext(context); } catch (e) { /* only frees caches */ }
    }
  } finally {
    for (let i = 0; i < marked.length; i++) marked[i]!.removeAttribute(MARK);
  }
  const notes = ["Re-drawn from the page's DOM; web fonts and images from CDNs may look different."];
  let w = rendered.width, h = Math.min(rendered.height, MAX_H);
  if (rendered.height > MAX_H) notes.push("Only the top " + Math.round(MAX_H / scale) + "px of the page are shown.");
  for (let attempt = 0; attempt < 4; attempt++) {
    const out = doc.createElement("canvas");
    out.width = Math.max(1, Math.round(w));
    out.height = Math.max(1, Math.round(h));
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(rendered, 0, 0, rendered.width * (w / rendered.width), rendered.height * (w / rendered.width));
    const qualities = [0.82, 0.68, 0.55, 0.42];
    for (let q = 0; q < qualities.length; q++) {
      const dataUrl = out.toDataURL("image/jpeg", qualities[q]);
      const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
      if (bytes <= MAX_BYTES && dataUrl.indexOf("data:image/jpeg;base64,") === 0) {
        return { dataUrl, width: out.width, height: out.height, note: notes.join(" ") };
      }
    }
    w *= 0.7;
    h *= 0.7;
  }
  throw new Error("the screenshot stayed over 400 KB");
}
