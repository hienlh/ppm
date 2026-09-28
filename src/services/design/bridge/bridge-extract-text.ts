/**
 * Text measurement for the PowerPoint export, shipped to the frame as `ppm.lib` helpers.
 *
 * Each function travels as its own source (see bridge-script.ts), so none may reference
 * anything in this module's scope; a helper that needs another is handed it as a parameter.
 *
 * A text block's content becomes a list of runs: each run is a stretch of text with one
 * style (weight, slant, underline, colour, size, face), and `breakLine` marks a line break
 * after it. Whitespace is collapsed the way CSS `white-space: normal` renders it, so the
 * PowerPoint text reads like the page rather than like its source indentation.
 */

export interface ExtractedColor {
  hex: string;
  alpha: number;
}

export interface ExtractedRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: ExtractedColor;
  sizePx?: number;
  font?: string;
  breakLine?: boolean;
}

/**
 * `rgb()`/`rgba()` (comma or space syntax, `%` channels, `/ alpha`), `#rgb[a]`,
 * `#rrggbb[aa]` and `transparent`. Anything else (`oklch()`, `color()`) is null, and the
 * bridge resolves it through a canvas instead.
 */
export function parseCssColor(value: string): ExtractedColor | null {
  const v = String(value || "").trim().toLowerCase();
  if (v === "transparent") return { hex: "000000", alpha: 0 };
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return { hex: h.slice(0, 6).toUpperCase(), alpha: h.length === 8 ? round(parseInt(h.slice(6), 16) / 255) : 1 };
  }
  const m = /^rgba?\(\s*([^)]*)\)$/.exec(v);
  if (!m) return null;
  const parts = m[1]!.split(/\s*[,/]\s*|\s+/).filter((p) => p !== "");
  if (parts.length < 3 || parts.length > 4) return null;
  const channels: number[] = [];
  for (let i = 0; i < 3; i++) {
    const p = parts[i]!;
    const n = p.endsWith("%") ? parseFloat(p) * 2.55 : parseFloat(p);
    if (!isFinite(n)) return null;
    channels.push(Math.max(0, Math.min(255, Math.round(n))));
  }
  let alpha = 1;
  if (parts.length === 4) {
    const p = parts[3]!;
    alpha = p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p);
    if (!isFinite(alpha)) return null;
    alpha = Math.max(0, Math.min(1, alpha));
  }
  const hexOf = (n: number): string => (n < 16 ? "0" : "") + n.toString(16);
  return { hex: (hexOf(channels[0]!) + hexOf(channels[1]!) + hexOf(channels[2]!)).toUpperCase(), alpha: round(alpha) };
}

/**
 * Joins adjacent runs of identical style, folds a bare line break into the run before it,
 * drops empty runs, and trims the collapsed spaces at the start and end of every line.
 */
export function mergeTextRuns(runs: ExtractedRun[]): ExtractedRun[] {
  const same = (a: ExtractedRun, b: ExtractedRun): boolean =>
    !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline
    && a.sizePx === b.sizePx && a.font === b.font
    && (a.color ? a.color.hex + a.color.alpha : "") === (b.color ? b.color.hex + b.color.alpha : "");
  const merged: ExtractedRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const prev = merged[merged.length - 1];
    if (run.text === "" && run.breakLine && prev && !prev.breakLine) {
      prev.breakLine = true;
      continue;
    }
    if (prev && !prev.breakLine && same(prev, run)) {
      prev.text += run.text;
      if (run.breakLine) prev.breakLine = true;
      continue;
    }
    merged.push(Object.assign({}, run));
  }
  // Trim line edges: the first run of a line loses leading spaces, the last trailing ones.
  let lineStart = 0;
  for (let i = 0; i < merged.length; i++) {
    const run = merged[i]!;
    if (i === lineStart) run.text = run.text.replace(/^ +/, "");
    if (run.breakLine || i === merged.length - 1) {
      run.text = run.text.replace(/ +$/, "");
      lineStart = i + 1;
    }
  }
  const out = merged.filter((r) => r.text !== "" || r.breakLine);
  // A trailing break has nothing after it to break before.
  while (out.length && out[out.length - 1]!.text === "") out.pop();
  if (out.length) delete out[out.length - 1]!.breakLine;
  return out;
}

/**
 * The raw runs of one text block: its text nodes and those of its `inline` descendants.
 * Descendants laid out as boxes (block, flex, inline-block…) are left out, because the
 * export measures them as blocks of their own. `note` records what cannot be reproduced.
 */
export function extractTextRuns(
  block: Element,
  win: Window,
  colorOf: (value: string) => ExtractedColor | null,
  note: (label: string) => void,
): ExtractedRun[] {
  const runs: ExtractedRun[] = [];
  const SKIP = /^(script|style|template|noscript|svg|img|canvas|video|audio|iframe|object|embed|input|select|textarea)$/i;
  // An engine that computes no display at all (happy-dom for unstyled tags) means inline.
  const INLINE = /^(inline|contents|)$/;

  const styleOf = (el: Element, underline: boolean): ExtractedRun => {
    const cs = win.getComputedStyle(el);
    const weight = parseInt(cs.fontWeight, 10);
    const run: ExtractedRun = { text: "" };
    if (cs.fontWeight === "bold" || weight >= 600) run.bold = true;
    if (cs.fontStyle === "italic" || cs.fontStyle.indexOf("oblique") === 0) run.italic = true;
    if (underline) run.underline = true;
    const color = colorOf(cs.color);
    if (color) run.color = color;
    const size = parseFloat(cs.fontSize);
    if (isFinite(size) && size > 0) run.sizePx = size;
    const family = (cs.fontFamily.split(",")[0] || "").trim().replace(/^["']|["']$/g, "");
    if (family) run.font = family;
    return run;
  };

  const visit = (node: Node, parent: Element, underline: boolean): void => {
    if (node.nodeType === 3) {
      const cs = win.getComputedStyle(parent);
      if (cs.visibility === "hidden") return;
      let text = (node as Text).data;
      const transform = cs.textTransform;
      if (transform === "uppercase") text = text.toUpperCase();
      else if (transform === "lowercase") text = text.toLowerCase();
      const pre = /^pre/.test(cs.whiteSpace) || cs.whiteSpace === "break-spaces";
      if (!pre) {
        const last = runs.length ? runs[runs.length - 1]! : null;
        text = text.replace(/[\t\n\r\f ]+/g, " ");
        // Collapse across element boundaries: "a <b> b</b>" renders one space.
        if (last && !last.breakLine && / $/.test(last.text) && text.charAt(0) === " ") text = text.slice(1);
        if (text !== "") runs.push(Object.assign(styleOf(parent, underline), { text }));
        return;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const run = Object.assign(styleOf(parent, underline), { text: lines[i]!.replace(/\t/g, "    ") });
        if (i < lines.length - 1) run.breakLine = true;
        runs.push(run);
      }
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      runs.push({ text: "", breakLine: true });
      return;
    }
    if (SKIP.test(tag)) return;
    const cs = win.getComputedStyle(el);
    if (cs.display === "none" || !INLINE.test(cs.display)) return;
    if (parseFloat(cs.marginLeft) || parseFloat(cs.marginRight) || parseFloat(cs.paddingLeft) || parseFloat(cs.paddingRight)) {
      note("spacing around inline text");
    }
    const bg = colorOf(cs.backgroundColor);
    if (bg && bg.alpha > 0) note("background behind inline text");
    const under = underline || cs.textDecorationLine.indexOf("underline") >= 0;
    for (let c = el.firstChild; c; c = c.nextSibling) visit(c, el, under);
  };

  const own = win.getComputedStyle(block).textDecorationLine.indexOf("underline") >= 0;
  for (let c = block.firstChild; c; c = c.nextSibling) visit(c, block, own);
  return runs;
}
