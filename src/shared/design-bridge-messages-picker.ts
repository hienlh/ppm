import { DESIGN_GEN_RE } from "./design-types";
import {
  COMMENT_ID_RE, COMMENT_LIMITS, CSS_PATH_RE, ELEMENT_TAG_RE, parseCommentAnchor, parseCommentQuote, parsePpmId,
  type CommentAnchor, type CommentQuote,
} from "./design-comment-types";

/**
 * Bridge messages for the element picker and comment pins, spread into the protocol's
 * registries.
 *
 * Frame → parent: `hover` (what the pointer or a first tap outlines), `select` (a click, a
 * second tap), `element-menu` (a long-press: select and open the composer), `picker-exit`
 * (Esc inside the frame) and `pins-rects` (where each pinned element is right now).
 * Parent → frame: `picker`, `pins-set`, `select-parent`, `clear-selection`.
 *
 * All of it is untrusted: the page's scripts can post the same shapes. Rects are clamped
 * to finite numbers, ids are integers or null, strings are capped. Nothing here causes a
 * write by itself — a re-anchor report only makes the parent *ask* the server, which
 * re-checks it against the source.
 */

export interface BridgeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PickedElement {
  ppmId: number | null;
  gen: string | null;
  file: string;
  tag: string;
  rect: BridgeRect;
  cssPath: string;
  /** The page's own markup for the element, for display only; never sent to the server or a prompt. */
  outerHtml: string;
  text: string;
  quote: CommentQuote;
}

export interface PinRect {
  id: string;
  rect: BridgeRect | null;
  ppmId: number | null;
  gen: string | null;
  /** True when the pin was found by its quote rather than its id; ppmId/gen are the new ones. */
  reanchored: boolean;
}

export const MAX_PINS = 500;
const MAX_OUTER_HTML = 2000;
const MAX_ELEMENT_TEXT = 500;
const COORD_LIMIT = 1e6;

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const clampCoord = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v)) : null;

export function parseBridgeRect(v: unknown): BridgeRect | null {
  if (!isRaw(v)) return null;
  const x = clampCoord(v.x), y = clampCoord(v.y), w = clampCoord(v.w), h = clampCoord(v.h);
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

const parseGen = (v: unknown): string | null | undefined =>
  v === null || v === undefined ? null : typeof v === "string" && DESIGN_GEN_RE.test(v) ? v : undefined;

export function parsePickedElement(v: unknown): PickedElement | null {
  if (!isRaw(v)) return null;
  const ppmId = parsePpmId(v.ppmId);
  const gen = parseGen(v.gen);
  const tag = typeof v.tag === "string" ? v.tag.toLowerCase() : "";
  const rect = parseBridgeRect(v.rect);
  const file = typeof v.file === "string" ? v.file.slice(0, COMMENT_LIMITS.file) : "";
  if (ppmId === undefined || gen === undefined || !ELEMENT_TAG_RE.test(tag) || !rect || !file) return null;
  const cssPath = typeof v.cssPath === "string" ? v.cssPath.slice(0, COMMENT_LIMITS.cssPath) : "";
  return {
    ppmId, gen, file, tag, rect,
    cssPath: CSS_PATH_RE.test(cssPath) ? cssPath : "",
    outerHtml: typeof v.outerHtml === "string" ? v.outerHtml.slice(0, MAX_OUTER_HTML) : "",
    text: typeof v.text === "string" ? v.text.slice(0, MAX_ELEMENT_TEXT) : "",
    quote: parseCommentQuote(v.quote),
  };
}

function parsePinRect(v: unknown): PinRect | null {
  if (!isRaw(v) || typeof v.id !== "string" || !COMMENT_ID_RE.test(v.id)) return null;
  const ppmId = parsePpmId(v.ppmId);
  const gen = parseGen(v.gen);
  if (ppmId === undefined || gen === undefined) return null;
  return { id: v.id, rect: v.rect === null ? null : parseBridgeRect(v.rect), ppmId, gen, reanchored: v.reanchored === true };
}

function parseList<T>(v: unknown, item: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > MAX_PINS) return null;
  const out: T[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed) out.push(parsed);
  }
  return out;
}

export const PICKER_CHILD_VALIDATORS = {
  hover: (m: Raw) => {
    if (m.el === null) return { type: "hover" as const, el: null };
    if (!isRaw(m.el)) return null;
    const tag = typeof m.el.tag === "string" ? m.el.tag.toLowerCase() : "";
    const rect = parseBridgeRect(m.el.rect);
    return ELEMENT_TAG_RE.test(tag) && rect ? { type: "hover" as const, el: { tag, rect } } : null;
  },
  select: (m: Raw) => {
    const el = parsePickedElement(m.el);
    return el ? { type: "select" as const, el } : null;
  },
  "element-menu": (m: Raw) => {
    const el = parsePickedElement(m.el);
    return el ? { type: "element-menu" as const, el } : null;
  },
  "picker-exit": () => ({ type: "picker-exit" as const }),
  "pins-rects": (m: Raw) => {
    const pins = parseList(m.pins, parsePinRect);
    return pins ? { type: "pins-rects" as const, pins } : null;
  },
};

export const PICKER_PARENT_VALIDATORS = {
  picker: (m: Raw) => (typeof m.on === "boolean" ? { type: "picker" as const, on: m.on } : null),
  "pins-set": (m: Raw) => {
    const pins = parseList(m.pins, (p): { id: string; anchor: CommentAnchor } | null => {
      if (!isRaw(p) || typeof p.id !== "string" || !COMMENT_ID_RE.test(p.id)) return null;
      const anchor = parseCommentAnchor(p.anchor);
      return anchor ? { id: p.id, anchor } : null;
    });
    return pins ? { type: "pins-set" as const, pins } : null;
  },
  "select-parent": () => ({ type: "select-parent" as const }),
  "clear-selection": () => ({ type: "clear-selection" as const }),
};
