import type { BridgeApi } from "./bridge-core.ts";

/**
 * The PowerPoint export's measuring pass, run by the bridge inside the live canvas.
 *
 * The browser already rendering the design is the renderer: every position comes from
 * `getBoundingClientRect` and every colour, size and face from `getComputedStyle`, so no
 * headless browser is involved. Slides are the `section.slide` elements (the slide convention
 * the design instructions teach), else `[data-slide]`, else the whole page as one slide.
 * Inside a slide, each laid-out box becomes a shape when it paints a background or a uniform
 * border, a text box when it holds text of its own, and images/SVG/canvas become pictures.
 *
 * What PowerPoint cannot show (gradients, background images, shadows, partial borders,
 * filters, blend modes, transforms other than rotation…) is counted per slide and reported,
 * never silently dropped. Shipped as source, so it references nothing outside itself; the
 * text and image helpers arrive through `ppm.lib`.
 */
export function installSlidesExtract(ppm: BridgeApi): void {
  const win = ppm.win as Window & typeof globalThis;
  const doc = ppm.doc;
  const lib = ppm.lib;
  const MAX_ITEMS = 600;
  const MAX_SLIDES = 200;
  const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
  const MAX_EDGE = 5376;
  const SKIP = /^(script|style|template|noscript|head|meta|link|title|br|wbr|option|datalist|ppm-design-overlay|ppm-design-handles)$/i;
  const MEDIA = /^(img|svg|canvas)$/i;
  // An engine that computes no display at all (happy-dom for unstyled tags) means inline.
  const INLINE = /^(inline|contents|)$/;
  type Color = { hex: string; alpha: number };
  type Frame = { left: number; top: number; scale: number; w: number; h: number };
  let probe: CanvasRenderingContext2D | null = null;

  function colorOf(value: string): Color | null {
    const parsed = lib.parseCssColor(value);
    if (parsed || !value) return parsed;
    // oklch(), lab(), color(): the canvas converts whatever the engine can paint.
    try {
      if (!probe) {
        const c = doc.createElement("canvas");
        c.width = c.height = 1;
        probe = c.getContext("2d", { willReadFrequently: true });
      }
      if (!probe) return null;
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return lib.parseCssColor("rgba(" + d[0] + "," + d[1] + "," + d[2] + "," + d[3]! / 255 + ")");
    } catch (e) {
      return null;
    }
  }

  /** The element's box in slide px; rotated boxes use their layout size around the rect's centre. */
  function boxOf(el: Element, f: Frame, deg: number) {
    const r = el.getBoundingClientRect();
    const he = el as HTMLElement;
    const rotated = deg !== 0 && typeof he.offsetWidth === "number";
    const w = rotated ? he.offsetWidth : r.width * f.scale;
    const h = rotated ? he.offsetHeight : r.height * f.scale;
    const cx = (r.left + r.width / 2 - f.left) * f.scale;
    const cy = (r.top + r.height / 2 - f.top) * f.scale;
    return { x: cx - w / 2, y: cy - h / 2, w, h, rotation: deg };
  }

  async function extractSlide(root: Element, f: Frame, note: (label: string) => void) {
    const items: Array<Record<string, unknown> | Promise<Record<string, unknown> | null>> = [];
    const onSlide = (b: { x: number; y: number; w: number; h: number }): boolean =>
      b.x < f.w && b.y < f.h && b.x + b.w > 0 && b.y + b.h > 0;
    const stack: Array<{ el: Element; opacity: number }> = [];
    const pushChildren = (el: Element, opacity: number): void => {
      for (let i = el.children.length - 1; i >= 0; i--) stack.push({ el: el.children[i]!, opacity });
    };
    pushChildren(root, 1);
    while (stack.length) {
      const { el, opacity } = stack.pop()!;
      if (SKIP.test(el.tagName)) continue;
      const cs = win.getComputedStyle(el);
      if (cs.display === "none") continue;
      const op = opacity * (parseFloat(cs.opacity) >= 0 ? parseFloat(cs.opacity) : 1);
      if (op <= 0.01) continue;
      const visible = cs.visibility !== "hidden";
      const media = MEDIA.test(el.tagName);
      if (visible && (media || !INLINE.test(cs.display))) {
        const rot = lib.cssRotation(cs);
        if (!rot.pure) note("transform other than rotation");
        const box = boxOf(el, f, rot.deg);
        // An empty box paints nothing: not worth a warning, and never an item.
        if (!(box.w > 0.5 && box.h > 0.5)) { /* nothing to draw */ }
        else if (!onSlide(box)) note("element outside the slide, left out");
        else if (items.length >= MAX_ITEMS) note("element over the per-slide limit, left out");
        else if (media) {
          if (op < 0.99) note("image opacity");
          items.push(lib.imageDataUrl(el, win).then((data) => {
            if (data) return Object.assign({ kind: "image", data }, box);
            note("image that could not be read");
            return null;
          }));
        } else {
          for (const item of lib.blockItems(el, win, box, op, colorOf, note, lib)) items.push(item);
        }
      }
      if (!media) pushChildren(el, op);
    }
    const resolved = await Promise.all(items);
    return resolved.filter((item): item is Record<string, unknown> => item !== null);
  }

  function backgroundOf(el: Element): Color | null {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const c = colorOf(win.getComputedStyle(node).backgroundColor);
      if (c && c.alpha > 0) return c;
    }
    return null;
  }

  async function extractDeck() {
    if (doc.fonts && doc.fonts.ready) await doc.fonts.ready;
    let roots = Array.prototype.slice.call(doc.querySelectorAll("section.slide")) as Element[];
    if (!roots.length) roots = Array.prototype.slice.call(doc.querySelectorAll("[data-slide]")) as Element[];
    const warnings: string[] = [];
    const de = doc.documentElement;
    const whole = roots.length === 0;
    const first = (whole ? de : roots[0]) as HTMLElement;
    const width = Math.min(MAX_EDGE, whole ? de.clientWidth : first.offsetWidth);
    const height = Math.min(MAX_EDGE, whole ? de.scrollHeight : first.offsetHeight);
    if (whole && de.scrollHeight > MAX_EDGE) warnings.push("The page is taller than a slide can be; everything below " + MAX_EDGE + "px was left out.");
    if (!whole && win.innerWidth < width * 0.9) warnings.push("The canvas is narrower than the slides; export from the Slide frame for the exact layout.");
    if (roots.length > MAX_SLIDES) warnings.push("Only the first " + MAX_SLIDES + " slides were exported.");
    if (!(width > 0 && height > 0)) throw new Error("The slides have no size on the canvas");
    const slides: Array<Record<string, unknown>> = [];
    let imageBytes = 0;
    const list = whole ? [doc.body || de] : roots.slice(0, MAX_SLIDES);
    for (let i = 0; i < list.length; i++) {
      const root = list[i]!;
      const r = (whole ? de : root).getBoundingClientRect();
      const counts: Record<string, number> = {};
      const note = (label: string): void => { counts[label] = (counts[label] || 0) + 1; };
      const layoutWidth = whole ? width : (root as HTMLElement).offsetWidth;
      if (!(r.width > 0 && layoutWidth > 0)) {
        warnings.push("Slide " + (i + 1) + " is hidden on the canvas, so it was exported empty.");
        slides.push({ items: [] });
        continue;
      }
      const frame = { left: r.left, top: r.top, scale: layoutWidth / r.width, w: width, h: height };
      const items = await extractSlide(root, frame, note);
      for (const item of items) if (typeof item.data === "string") imageBytes += item.data.length;
      if (imageBytes > MAX_IMAGE_BYTES) throw new Error("The slides' images add up to more than 50 MB");
      const slide: Record<string, unknown> = { items };
      const bg = backgroundOf(root);
      if (bg) slide.background = bg;
      const own = win.getComputedStyle(root).backgroundImage;
      if (own && own !== "none") note(own.indexOf("gradient") >= 0 ? "gradient slide background" : "slide background image");
      for (const label in counts) warnings.push("Slide " + (i + 1) + ": " + label + (counts[label]! > 1 ? " (" + counts[label] + "x)" : ""));
      slides.push(slide);
    }
    return { width, height, slides, warnings: warnings.slice(0, 200) };
  }

  ppm.on("slides-extract", (m) => {
    const requestId = m.requestId;
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) return;
    extractDeck().then(
      (deck) => ppm.post("slides-data", { requestId, doc: deck }),
      (e) => ppm.post("slides-error", { requestId, message: String((e && (e as Error).message) || e).slice(0, 300) }),
    );
  });
}
