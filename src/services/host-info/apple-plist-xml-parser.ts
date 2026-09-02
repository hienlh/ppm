/** Minimal parser for `plutil -convert xml1 -o -` output — not a general XML
 *  parser, just enough of Apple's plist DTD (`dict`/`array`/`string`/
 *  `integer`/`real`/`true`/`false`/`data`) to walk an NSKeyedArchiver
 *  container. Avoids pulling in an XML dependency for a fixed, well-known
 *  tag set, same rationale as the Linux GTK/KDE bookmark regex parsers. */

export type PlistValue =
  | string
  | number
  | boolean
  | Buffer
  | PlistValue[]
  | { [key: string]: PlistValue };

interface Frame {
  type: "array" | "dict";
  items: PlistValue[];
  keys: string[];
  /** The dict's own "awaiting a value" key — scoped per-frame, not global, because a
   *  `<key>k</key><array>...<dict>...<key>other</key>...</dict>...</array>` sequence
   *  nests another dict (with its own key/value turns) before the outer key is consumed. */
  pendingKey: string | null;
}

const TAG_RE = /<(\/)?([a-zA-Z][\w.-]*)([^>]*?)(\/)?>/g;

export class PlistParseError extends Error {}

/** Parse plist XML text into a plain JS value tree (dict → object, array → array, data → Buffer). */
export function parsePlistXml(xml: string): PlistValue {
  TAG_RE.lastIndex = 0;
  const stack: Frame[] = [];
  let root: PlistValue | undefined;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  function place(value: PlistValue): void {
    const top = stack[stack.length - 1];
    if (!top) {
      root = value;
      return;
    }
    if (top.type === "array") {
      top.items.push(value);
      return;
    }
    if (top.pendingKey === null) throw new PlistParseError("dict value without a preceding <key>");
    top.keys.push(top.pendingKey);
    top.items.push(value);
    top.pendingKey = null;
  }

  while ((match = TAG_RE.exec(xml))) {
    const closing = !!match[1];
    const name = match[2]!;
    const selfClose = !!match[4];
    const between = xml.slice(lastIndex, match.index);
    lastIndex = TAG_RE.lastIndex;

    if (name === "?xml" || name === "plist" || name === "!DOCTYPE") continue;

    if (selfClose) {
      if (name === "true") place(true);
      else if (name === "false") place(false);
      else if (name === "dict") place({});
      else if (name === "array") place([]);
      continue;
    }
    if (!closing) {
      if (name === "dict" || name === "array") stack.push({ type: name, items: [], keys: [], pendingKey: null });
      continue; // other opening tags (string/integer/...) are handled on their closing tag below
    }

    // closing tag
    if (name === "key") {
      const top = stack[stack.length - 1];
      if (!top || top.type !== "dict") throw new PlistParseError("<key> outside of a <dict>");
      top.pendingKey = between;
    } else if (name === "dict") {
      const frame = stack.pop();
      if (!frame) throw new PlistParseError("unbalanced </dict>");
      const obj: Record<string, PlistValue> = {};
      frame.keys.forEach((k, i) => {
        obj[k] = frame.items[i]!;
      });
      place(obj);
    } else if (name === "array") {
      const frame = stack.pop();
      if (!frame) throw new PlistParseError("unbalanced </array>");
      place(frame.items);
    } else if (name === "string") {
      place(between);
    } else if (name === "integer") {
      place(parseInt(between, 10));
    } else if (name === "real") {
      place(parseFloat(between));
    } else if (name === "data") {
      place(Buffer.from(between.replace(/\s+/g, ""), "base64"));
    } else if (name === "date") {
      place(between);
    }
    // Unrecognized closing tags are ignored — tolerant of plist dialects we don't need.
  }

  if (root === undefined) throw new PlistParseError("empty or unparsable plist document");
  return root;
}
