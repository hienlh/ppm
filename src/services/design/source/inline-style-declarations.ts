/**
 * The declarations of a `style` attribute value, read from its raw source text — entities
 * and all — so a merge can change some declarations and leave every other byte alone.
 *
 * The scanner walks the raw text, but decides structure on what each piece *decodes* to:
 * `&quot;` opens a string exactly like `"` does, and the `;` that ends an entity is not a
 * declaration separator (`font-family: &quot;Inter&quot;; color: red` is two declarations,
 * not four). Strings, parentheses (`url(data:…;base64,…)`) and comments are skipped as
 * units. Names are compared case-insensitively, as CSS does.
 */

export interface StyleDeclaration {
  /** Lowercased property name. */
  name: string;
  /** Raw span of the whole declaration, without the `;` that ends it. */
  start: number;
  end: number;
  important: boolean;
}

const NAMED: Record<string, string> = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", semi: ";", lpar: "(", rpar: ")", colon: ":", sol: "/", ast: "*" };

/** The character a raw unit stands for, and how many raw characters it spans. */
function unitAt(raw: string, i: number): [string, number] {
  if (raw[i] !== "&") return [raw[i]!, 1];
  const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/.exec(raw.slice(i, i + 40));
  if (!m) return ["&", 1];
  const ref = m[1]!;
  let ch: string | undefined;
  if (ref[0] === "#") {
    const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    ch = code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
  } else {
    // An entity outside this table decodes to text that has no meaning to the scanner.
    ch = NAMED[ref] ?? "x";
  }
  return [ch, m[0].length];
}

export function parseStyleDeclarations(raw: string): StyleDeclaration[] {
  const out: StyleDeclaration[] = [];
  let declStart = 0;
  let colon = -1;
  let depth = 0;
  let quote: string | null = null;
  let comment = false;
  const finish = (end: number): void => {
    if (colon >= 0) {
      const head = raw.slice(declStart, colon);
      // A comment in front of the name belongs to the declaration's span but not to its name.
      const name = head.replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
      const start = declStart + (head.length - head.trimStart().length);
      const important = /!\s*important\s*$/i.test(raw.slice(colon + 1, end).trim());
      if (name) out.push({ name, start, end: trimEnd(raw, end, start), important });
    }
    colon = -1;
  };
  for (let i = 0; i < raw.length;) {
    const [ch, len] = unitAt(raw, i);
    if (comment) {
      if (ch === "*" && unitAt(raw, i + len)[0] === "/") {
        comment = false;
        i += len + unitAt(raw, i + len)[1];
        continue;
      }
    } else if (quote) {
      if (ch === "\\") i += len;
      else if (ch === quote) quote = null;
    } else if (ch === "/" && unitAt(raw, i + len)[0] === "*") {
      comment = true;
      i += len + unitAt(raw, i + len)[1];
      continue;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === ":" && colon < 0 && depth === 0) {
      colon = i;
    } else if (ch === ";" && depth === 0) {
      finish(i);
      declStart = i + len;
    }
    i += len;
  }
  finish(raw.length);
  return out;
}

function trimEnd(raw: string, end: number, floor: number): number {
  let e = end;
  while (e > floor && /\s/.test(raw[e - 1]!)) e--;
  return e;
}

/**
 * `raw` with each prop set. The last declaration of a property is rewritten in place (its
 * `!important` kept, so it still wins where it won before); earlier declarations of the same
 * property are removed, since they are dead text that would now disagree with it; a property
 * the attribute does not have is appended. Every other byte is kept.
 */
export function mergeStyle(raw: string, props: Readonly<Record<string, string>>): string {
  const decls = parseStyleDeclarations(raw);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const appended: string[] = [];
  for (const [name, value] of Object.entries(props)) {
    const same = decls.filter((d) => d.name === name);
    const last = same[same.length - 1];
    if (!last) {
      appended.push(`${name}: ${value}`);
      continue;
    }
    edits.push({ start: last.start, end: last.end, text: `${name}: ${value}${last.important ? " !important" : ""}` });
    for (const d of same.slice(0, -1)) {
      // The declaration and the `;` (plus spacing) that followed it.
      let end = d.end;
      while (end < raw.length && /\s/.test(raw[end]!)) end++;
      if (raw[end] === ";") end++;
      while (end < raw.length && /[ \t]/.test(raw[end]!)) end++;
      edits.push({ start: d.start, end, text: "" });
    }
  }
  let text = raw;
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  if (appended.length === 0) return text;
  const body = text.replace(/\s+$/, "");
  const tail = text.slice(body.length);
  const sep = body === "" ? "" : body.endsWith(";") ? " " : "; ";
  return `${body}${sep}${appended.join("; ")}${tail}`;
}
