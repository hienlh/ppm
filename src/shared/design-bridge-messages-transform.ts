import { DESIGN_GEN_RE } from "./design-types";
import { ELEMENT_TAG_RE, parsePpmId } from "./design-comment-types";
import { parseBridgeRect, type BridgeRect } from "./design-bridge-messages-picker";

/**
 * Bridge messages for moving and resizing an element on the canvas, spread into the
 * protocol's registries.
 *
 * Parent → frame: `transform-mode` (Move on/off, and the canvas scale, so handles stay 44
 * screen px), `transform-target` (which element gets handles), `transform-nudge` (arrow keys
 * pressed in the parent's canvas pane) and `transform-cancel` (put the live style back).
 * Frame → parent: `transform-live` (where the element is while it moves) and
 * `transform-commit`, which is only a **proposal**: the page's own scripts can post the same
 * shape, so the parent decides whether anything is written (see
 * `design-transform-proposal.ts`), and the server validates the props again with
 * {@link parseTransformProps}.
 */

export type TransformProp = "translate" | "width" | "height";
export type TransformProps = Partial<Record<TransformProp, string>>;

export interface TransformBox {
  /** The `translate` offsets and the `width`/`height` the element has right now, in px. */
  tx: number;
  ty: number;
  w: number;
  h: number;
}

/** Largest absolute px value a write may carry. */
export const MAX_TRANSFORM_PX = 20000;
/** Largest single nudge, in frame px. */
export const MAX_NUDGE_PX = 1000;

const PX = "(-?\\d{1,5}(?:\\.\\d{1,2})?)px";
const TRANSLATE_RE = new RegExp(`^${PX} ${PX}$`);
const SIZE_RE = /^(\d{1,5}(?:\.\d{1,2})?)px$/;

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const inRange = (s: string): boolean => Math.abs(Number(s)) <= MAX_TRANSFORM_PX;
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The three properties a canvas write may set, each a plain px value: `translate` as
 * `"<n>px <n>px"`, `width`/`height` as `"<n>px"` (not negative), |n| ≤ 20000 with at most
 * two decimals. Anything else, any other key, or nothing at all is null. The server trusts
 * no other check than this one.
 */
export function parseTransformProps(v: unknown): TransformProps | null {
  if (!isRaw(v)) return null;
  const keys = Object.keys(v);
  if (keys.length === 0 || keys.length > 3) return null;
  const out: TransformProps = {};
  for (const key of keys) {
    const value = v[key];
    if (typeof value !== "string") return null;
    if (key === "translate") {
      const m = TRANSLATE_RE.exec(value);
      if (!m || !inRange(m[1]!) || !inRange(m[2]!)) return null;
      out.translate = value;
    } else if (key === "width" || key === "height") {
      const m = SIZE_RE.exec(value);
      if (!m || !inRange(m[1]!)) return null;
      out[key] = value;
    } else {
      return null;
    }
  }
  return out;
}

function parseBox(v: unknown): TransformBox | null {
  if (!isRaw(v)) return null;
  const tx = finite(v.tx), ty = finite(v.ty), w = finite(v.w), h = finite(v.h);
  if (tx === null || ty === null || w === null || h === null) return null;
  const clamp = (n: number) => Math.max(-1e6, Math.min(1e6, n));
  return { tx: clamp(tx), ty: clamp(ty), w: Math.max(0, clamp(w)), h: Math.max(0, clamp(h)) };
}

export const TRANSFORM_CHILD_VALIDATORS = {
  "transform-live": (m: Raw) => {
    const ppmId = parsePpmId(m.ppmId);
    if (typeof ppmId !== "number") return null;
    const rect: BridgeRect | null = m.rect === null ? null : parseBridgeRect(m.rect);
    if (m.rect !== null && !rect) return null;
    const box = m.box === null || m.box === undefined ? null : parseBox(m.box);
    return { type: "transform-live" as const, ppmId, rect, box };
  },
  "transform-commit": (m: Raw) => {
    const ppmId = parsePpmId(m.ppmId);
    const tag = typeof m.tag === "string" ? m.tag.toLowerCase() : "";
    const gen = typeof m.gen === "string" && DESIGN_GEN_RE.test(m.gen) ? m.gen : null;
    const file = typeof m.file === "string" && m.file.length <= 1024 ? m.file : "";
    const props = parseTransformProps(m.props);
    if (typeof ppmId !== "number" || !ELEMENT_TAG_RE.test(tag) || !gen || !file || !props) return null;
    return { type: "transform-commit" as const, ppmId, tag, gen, file, props };
  },
};

export const TRANSFORM_PARENT_VALIDATORS = {
  "transform-mode": (m: Raw) => {
    const scale = finite(m.scale);
    if (typeof m.on !== "boolean" || scale === null || scale <= 0 || scale > 10) return null;
    return { type: "transform-mode" as const, on: m.on, scale };
  },
  /** `ppmId: null` drops the handles. */
  "transform-target": (m: Raw) => {
    if (m.ppmId === null) return { type: "transform-target" as const, ppmId: null, tag: "" };
    const ppmId = parsePpmId(m.ppmId);
    const tag = typeof m.tag === "string" ? m.tag.toLowerCase() : "";
    return typeof ppmId === "number" && ELEMENT_TAG_RE.test(tag) ? { type: "transform-target" as const, ppmId, tag } : null;
  },
  "transform-nudge": (m: Raw) => {
    const dx = finite(m.dx), dy = finite(m.dy);
    if (dx === null || dy === null || !Number.isInteger(dx) || !Number.isInteger(dy)) return null;
    if (Math.abs(dx) > MAX_NUDGE_PX || Math.abs(dy) > MAX_NUDGE_PX || (dx === 0 && dy === 0)) return null;
    return { type: "transform-nudge" as const, dx, dy };
  },
  "transform-cancel": () => ({ type: "transform-cancel" as const }),
};
