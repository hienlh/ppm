import { parse } from "parse5";
import { tagNameEnd } from "../preview/html-instrument.ts";
import { findByStartOffset } from "./element-source-range.ts";
import { mergeStyle } from "./inline-style-declarations.ts";

export { mergeStyle, parseStyleDeclarations } from "./inline-style-declarations.ts";

/**
 * Writes a canvas move/resize into the source: the `style` attribute of one element's start
 * tag, and nothing else.
 *
 * The element is the one whose start tag begins at `ppmId` (its `data-ppm-id`, i.e. the
 * offset of its `<` in the BOM-less text) and must have the expected tag, or the edit is
 * refused as `element-moved`. parse5 records each attribute's location (keyed by lowercased
 * name, spanning `name=value`, the first of two duplicates — the one the browser keeps), so
 * only that span is rewritten: the original name spelling (`STYLE`), quote character and
 * every declaration not being set stay byte-for-byte. A tag with no `style` gets one right
 * after its name, which also works for a self-closing `<rect/>`. The element's own start
 * offset never moves, so its id stays valid for the reloaded canvas.
 *
 * The returned span is exactly what changed, for the undo journal.
 */

export interface SourceSpan {
  start: number;
  oldText: string;
  newText: string;
}

export type StylePatchResult =
  | { text: string; span: SourceSpan }
  | { error: "element-moved"; message: string };

/** Text safe inside a double- or single-quoted attribute value. */
export function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const moved = (message: string): StylePatchResult => ({ error: "element-moved", message });

function styleAttribute(attrText: string, props: Record<string, string>): string {
  const m = /^([^\s=]+)(\s*=\s*)([\s\S]*)$/.exec(attrText);
  // A bare `style` with no value.
  if (!m) return `${attrText}="${mergeStyle("", props)}"`;
  const [, name, eq, value] = m as unknown as [string, string, string, string];
  const q = value[0] === '"' || value[0] === "'" ? value[0] : null;
  if (!q) {
    // Unquoted: the new declarations hold spaces, so the value has to be quoted now. An
    // unquoted value cannot contain a quote, so nothing in it needs escaping.
    return `${name}${eq}"${mergeStyle(value, props)}"`;
  }
  const closed = value.length > 1 && value.endsWith(q);
  const inner = closed ? value.slice(1, -1) : value.slice(1);
  return `${name}${eq}${q}${mergeStyle(inner, props)}${closed ? q : ""}`;
}

export function patchStartTagStyle(
  text: string,
  ppmId: number,
  tag: string,
  props: Readonly<Record<string, string>>,
): StylePatchResult {
  if (!Number.isInteger(ppmId) || ppmId < 0 || ppmId >= text.length || text.charCodeAt(ppmId) !== 60 /* < */) {
    return moved("There is no element at that position any more");
  }
  const el = findByStartOffset(parse(text, { sourceCodeLocationInfo: true }), ppmId);
  const startTag = el?.sourceCodeLocation?.startTag;
  if (!el || !startTag) return moved("There is no element at that position any more");
  if (el.tagName.toLowerCase() !== tag) return moved(`The element at that position is a <${el.tagName.toLowerCase()}>, not a <${tag}>`);

  // Validated px values need no escaping; escaping anyway keeps this safe for any caller.
  const safe = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, escapeAttr(v)]));
  const loc = el.sourceCodeLocation?.attrs?.style;
  const span: SourceSpan = loc
    ? { start: loc.startOffset, oldText: text.slice(loc.startOffset, loc.endOffset), newText: "" }
    : { start: tagNameEnd(text, ppmId), oldText: "", newText: "" };
  span.newText = loc ? styleAttribute(span.oldText, safe) : ` style="${mergeStyle("", safe)}"`;
  return { text: text.slice(0, span.start) + span.newText + text.slice(span.start + span.oldText.length), span };
}
