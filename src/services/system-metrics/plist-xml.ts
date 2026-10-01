/**
 * XML property lists, as `ioreg -a` and `diskutil -plist` print them — one parser
 * for every darwin source, instead of a regex per tool.
 *
 * Deliberately small: the plist DTD has eight value elements and no attributes
 * that matter, and both tools emit it pretty-printed and well formed. What is
 * handled carefully is what arrives from outside the machine's own software: a
 * USB device names itself, so every string is entity-decoded exactly once and a
 * dictionary has no prototype (a device called `__proto__` is just a key).
 *
 * `integer` becomes a JS number. IOKit's 64-bit values (registry ids, byte
 * counters) stay below 2^53 in practice; one that did not would lose precision,
 * never throw.
 */

export type PlistValue = string | number | boolean | Uint8Array | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g;

type Frame =
  | { kind: "dict"; value: PlistDict; key: string | undefined }
  | { kind: "array"; value: PlistValue[] };

/** The document's root value, or undefined for anything that is not a plist. */
export function parsePlistXml(xml: string): PlistValue | undefined {
  const stack: Frame[] = [];
  let root: PlistValue | undefined;
  let rootSet = false;
  let text = "";
  /** The element whose text is being collected: key, string, integer, … */
  let leaf: string | undefined;

  const place = (value: PlistValue): boolean => {
    const top = stack[stack.length - 1];
    if (!top) {
      if (rootSet) return false;
      root = value;
      rootSet = true;
      return true;
    }
    if (top.kind === "array") {
      top.value.push(value);
      return true;
    }
    if (top.key === undefined) return false;
    top.value[top.key] = value;
    top.key = undefined;
    return true;
  };

  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(xml); m; m = TOKEN.exec(xml)) {
    if (leaf !== undefined) text += xml.slice(last, m.index);
    last = TOKEN.lastIndex;
    const name = m[2];
    if (!name) continue; // comment, declaration, doctype
    const closing = m[1] === "/";
    const selfClosing = m[3] === "/";

    if (name === "plist") continue;

    if (!closing) {
      if (leaf !== undefined) return undefined; // an element inside a leaf
      switch (name) {
        case "dict": {
          const dict: PlistDict = Object.create(null);
          if (selfClosing) {
            if (!place(dict)) return undefined;
          } else {
            stack.push({ kind: "dict", value: dict, key: undefined });
          }
          continue;
        }
        case "array": {
          if (selfClosing) {
            if (!place([])) return undefined;
          } else {
            stack.push({ kind: "array", value: [] });
          }
          continue;
        }
        case "true":
        case "false":
          if (!place(name === "true")) return undefined;
          continue;
        case "key":
        case "string":
        case "integer":
        case "real":
        case "data":
        case "date":
          if (selfClosing) {
            const value = leafValue(name, "");
            if (value === undefined) return undefined;
            if (name === "key") {
              if (!setKey(stack, "")) return undefined;
            } else if (!place(value)) return undefined;
          } else {
            leaf = name;
            text = "";
          }
          continue;
        default:
          return undefined;
      }
    }

    // A closing tag.
    if (leaf !== undefined) {
      if (name !== leaf) return undefined;
      const raw = text;
      leaf = undefined;
      if (name === "key") {
        if (!setKey(stack, decodeEntities(raw))) return undefined;
        continue;
      }
      const value = leafValue(name, raw);
      if (value === undefined || !place(value)) return undefined;
      continue;
    }
    if (name === "true" || name === "false") continue;
    const top = stack.pop();
    if (!top || top.kind !== name) return undefined;
    if (top.kind === "dict" && top.key !== undefined) return undefined; // a key with no value
    if (!place(top.value)) return undefined;
  }
  if (stack.length > 0 || leaf !== undefined) return undefined;
  return root;
}

function setKey(stack: Frame[], key: string): boolean {
  const top = stack[stack.length - 1];
  if (!top || top.kind !== "dict" || top.key !== undefined) return false;
  top.key = key;
  return true;
}

function leafValue(name: string, raw: string): PlistValue | undefined {
  switch (name) {
    case "key":
    case "string":
    case "date":
      return decodeEntities(raw);
    case "integer": {
      const t = raw.trim();
      if (!/^[+-]?(\d+|0x[0-9a-fA-F]+)$/.test(t)) return undefined;
      const n = t.includes("x") ? Number.parseInt(t.replace(/^([+-]?)0x/, "$1"), 16) : Number(t);
      return Number.isFinite(n) ? n : undefined;
    }
    case "real": {
      const n = Number(raw.trim());
      return Number.isFinite(n) ? n : undefined;
    }
    case "data": {
      const b64 = raw.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return undefined;
      return new Uint8Array(Buffer.from(b64, "base64"));
    }
    default:
      return undefined;
  }
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** One pass, so `&amp;lt;` stays the text `&lt;` rather than becoming `<`. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

// ---------------------------------------------------------------- narrowing

export function isPlistDict(v: PlistValue | undefined): v is PlistDict {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);
}

export const plistDict = (v: PlistValue | undefined): PlistDict | undefined => (isPlistDict(v) ? v : undefined);
export const plistArray = (v: PlistValue | undefined): PlistValue[] | undefined => (Array.isArray(v) ? v : undefined);
export const plistString = (v: PlistValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);
export const plistNumber = (v: PlistValue | undefined): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
export const plistBool = (v: PlistValue | undefined): boolean | undefined => (typeof v === "boolean" ? v : undefined);
export const plistData = (v: PlistValue | undefined): Uint8Array | undefined => (v instanceof Uint8Array ? v : undefined);

/** `ioreg` writes a device's own strings (`compatible`, `name`) as NUL-terminated
 *  data rather than as a string. */
export function plistCString(v: PlistValue | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (!(v instanceof Uint8Array)) return undefined;
  const end = v.indexOf(0);
  const text = new TextDecoder().decode(end >= 0 ? v.subarray(0, end) : v);
  return text.length > 0 ? text : undefined;
}
