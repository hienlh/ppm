/**
 * Image capture for the PowerPoint export, shipped to the frame as a `ppm.lib` helper (so,
 * like every helper, it references nothing outside itself).
 *
 * The answer is always a PNG or JPEG data URL, the two formats every PowerPoint opens:
 *  - an image from the design's own files is fetched (the design CSP's `connect-src` allows
 *    exactly that source) and kept as-is when it is already PNG/JPEG, else drawn to a canvas;
 *  - an image from a CDN cannot be fetched, so it is loaded with `crossOrigin="anonymous"`
 *    and drawn — jsDelivr and unpkg send CORS headers, anything that does not taints the
 *    canvas, and that image is reported rather than exported;
 *  - an inline `<svg>` is serialised and rasterised at twice its on-screen size, so it
 *    stays sharp on a projector; a `<canvas>` is read directly.
 * Null means "could not be read", never a partial image.
 */
export function imageDataUrl(el: Element, win: Window): Promise<string | null> {
  const doc = win.document;
  const MAX_EDGE = 4096;
  const rect = el.getBoundingClientRect();

  const draw = (img: HTMLImageElement, w: number, h: number): string | null => {
    if (!(w > 0 && h > 0)) return null;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = doc.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    } catch (e) {
      // A tainted canvas (a cross-origin image without CORS) refuses to be read.
      return null;
    }
  };

  const load = (src: string, cors: boolean): Promise<HTMLImageElement | null> => new Promise((resolve) => {
    const img = new (win as Window & typeof globalThis).Image();
    if (cors) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

  const fromBlob = (blob: Blob, vector: boolean): Promise<string | null> => {
    if (blob.type === "image/png" || blob.type === "image/jpeg") {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    }
    const url = URL.createObjectURL(blob);
    return load(url, false).then((img) => {
      URL.revokeObjectURL(url);
      if (!img) return null;
      // A vector source has no meaningful natural size: draw it at twice its displayed size.
      return vector || !img.naturalWidth
        ? draw(img, rect.width * 2, rect.height * 2)
        : draw(img, img.naturalWidth, img.naturalHeight);
    });
  };

  const tag = el.tagName.toLowerCase();
  if (tag === "canvas") {
    try {
      return Promise.resolve((el as HTMLCanvasElement).toDataURL("image/png"));
    } catch (e) {
      return Promise.resolve(null);
    }
  }
  if (tag === "svg") {
    let xml = new XMLSerializer().serializeToString(el);
    if (!/^<svg[^>]*\sxmlns=/.test(xml)) xml = xml.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
    return fromBlob(new Blob([xml], { type: "image/svg+xml" }), true);
  }
  if (tag !== "img") return Promise.resolve(null);
  const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
  if (!src) return Promise.resolve(null);
  if (/^data:image\/(png|jpeg);base64,/.test(src)) return Promise.resolve(src);
  let own = false;
  try {
    const url = new URL(src, doc.baseURI);
    own = url.protocol === "data:" || url.protocol === "blob:" || url.origin === win.location.origin;
  } catch (e) {
    return Promise.resolve(null);
  }
  if (own) {
    return fetch(src)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => (blob ? fromBlob(blob, blob.type === "image/svg+xml") : null))
      .catch(() => null);
  }
  return load(src, true).then((img) => (img ? draw(img, img.naturalWidth || rect.width * 2, img.naturalHeight || rect.height * 2) : null));
}
