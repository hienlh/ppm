import { rootSelectorKind } from "./css-root-selector.ts";

/**
 * Finds and rewrites custom-property declarations of top-level `:root` / `html` rules in a
 * stylesheet, touching nothing else: every edit is a splice at offsets this scanner found,
 * never a re-serialisation, so the rest of the file stays byte-identical.
 *
 * It is a scanner, not a CSS parser. It knows enough to never be fooled by `:root{` inside a
 * comment, a string or an unquoted `url(...)` (a data URL holds `;` and `{`), to skip nested
 * blocks, and to mark a declaration inside any at-rule block (`@media`, `@supports`,
 * `@layer`, …) as `conditional`, since it is not always in effect. Everything it does not
 * understand is skipped rather than guessed at; the caller then appends a fresh `:root`
 * block at the end, which wins the cascade, and never prepends one, which would lose it.
 */

export interface RootVarDeclaration {
  var: string;
  /** The value, without surrounding whitespace, comments or `!important`. */
  valueStart: number;
  valueEnd: number;
  conditional: boolean;
  /** The innermost enclosing at-rule (`@media`), when conditional. */
  atRule: string | null;
  /** The selector is `:root` or `html` alone, not a list that also names other elements. */
  exclusive: boolean;
  important: boolean;
}

export interface CssRootScan {
  declarations: RootVarDeclaration[];
  /** False when the text ends inside a comment, string, block or rule prelude: appending there would be swallowed. */
  endsClean: boolean;
}

const GROUPING_AT_RULES = new Set(["media", "supports", "layer", "container", "document", "scope", "starting-style"]);
const WS = /\s/;
const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
/** An unquoted `url(`: its contents are literal up to `)`, quotes, `;` and `{` included. */
const UNQUOTED_URL = /url\(\s*[^\s"')]/iy;

export function scanRootVars(css: string): CssRootScan {
  const len = css.length;
  const declarations: RootVarDeclaration[] = [];
  let clean = true;

  const skipComment = (i: number): number => {
    const close = css.indexOf("*/", i + 2);
    if (close < 0) { clean = false; return len; }
    return close + 2;
  };
  const skipString = (i: number): number => {
    const quote = css[i];
    for (let j = i + 1; j < len; j++) {
      if (css[j] === "\\") j++;
      else if (css[j] === quote) return j + 1;
      else if (css[j] === "\n") return j; // an unterminated string ends at the line break
    }
    clean = false;
    return len;
  };
  /** Index of the first `stops` character outside comments, strings and nested brackets. */
  const scanUntil = (from: number, stops: string): number => {
    const stack: string[] = [];
    let i = from;
    while (i < len) {
      const c = css[i]!;
      if (c === "/" && css[i + 1] === "*") { i = skipComment(i); continue; }
      if (c === '"' || c === "'") { i = skipString(i); continue; }
      if (c === "\\") { if (i + 1 >= len) clean = false; i += 2; continue; }
      if (stack.length === 0 && stops.includes(c)) return i;
      UNQUOTED_URL.lastIndex = i;
      if ((c === "u" || c === "U") && UNQUOTED_URL.test(css) && !/[\w-]/.test(css[i - 1] ?? "")) {
        const close = css.indexOf(")", i + 4);
        if (close < 0) { clean = false; return len; }
        i = close + 1;
        continue;
      }
      if (CLOSER[c]) stack.push(CLOSER[c]!);
      else if (stack.length && c === stack[stack.length - 1]) stack.pop();
      i++;
    }
    if (stack.length) clean = false;
    return len;
  };
  /** `open` is a `{`; answers the index of its `}` (len when unterminated). */
  const blockEnd = (open: number): number => {
    const end = scanUntil(open + 1, "}");
    if (end >= len) clean = false;
    return end;
  };
  const skipSpace = (i: number, end: number): number => {
    while (i < end) {
      if (WS.test(css[i]!)) i++;
      else if (css.startsWith("/*", i)) i = skipComment(i);
      else if (css.startsWith("<!--", i)) i += 4;
      else if (css.startsWith("-->", i)) i += 3;
      else break;
    }
    return i;
  };

  const declaration = (start: number, end: number, ctx: { atRule: string | null; exclusive: boolean }): void => {
    const name = /^--[A-Za-z0-9_-]+/.exec(css.slice(start, Math.min(end, start + 200)));
    if (!name) return;
    const colon = skipSpace(start + name[0].length, end);
    if (css[colon] !== ":") return;
    let first = -1, last = colon + 1;
    for (let k = colon + 1; k < end;) {
      if (css.startsWith("/*", k)) { k = skipComment(k); continue; }
      if (WS.test(css[k]!)) { k++; continue; }
      if (first < 0) first = k;
      k = css[k] === '"' || css[k] === "'" ? skipString(k) : k + 1;
      last = Math.min(k, end);
    }
    let valueStart = first < 0 ? colon + 1 : first;
    let valueEnd = first < 0 ? colon + 1 : last;
    const important = /!\s*important$/i.exec(css.slice(valueStart, valueEnd));
    if (important) {
      valueEnd -= important[0].length;
      while (valueEnd > valueStart && WS.test(css[valueEnd - 1]!)) valueEnd--;
    }
    declarations.push({
      var: name[0], valueStart, valueEnd, conditional: ctx.atRule !== null, atRule: ctx.atRule,
      exclusive: ctx.exclusive, important: !!important,
    });
  };

  const declarations_ = (start: number, end: number, ctx: { atRule: string | null; exclusive: boolean }): void => {
    let i = start;
    while (i < end) {
      i = skipSpace(i, end);
      if (css[i] === ";") { i++; continue; }
      if (i >= end) break;
      let stop = Math.min(scanUntil(i, ";{}"), end);
      if (css[stop] === "{") {
        const close = blockEnd(stop);
        // A custom property may hold a `{}` block as its value; anything else is a nested rule.
        if (!/^--[A-Za-z0-9_-]+\s*:/.test(css.slice(i, stop))) { i = close + 1; continue; }
        stop = Math.min(scanUntil(close + 1, ";}"), end);
      }
      declaration(i, stop, ctx);
      i = stop;
    }
  };

  const rules = (start: number, end: number, atRule: string | null): void => {
    let i = start;
    while (i < end) {
      i = skipSpace(i, end);
      if (i >= end) break;
      if (css[i] === "}" || css[i] === ";") { i++; continue; }
      const stop = scanUntil(i, css[i] === "@" ? "{;" : "{");
      if (stop >= end) {
        // A prelude with nothing after it: text appended now would join it.
        if (stop >= len) clean = false;
        break;
      }
      if (css[stop] === ";") { i = stop + 1; continue; }
      const close = blockEnd(stop);
      if (css[i] === "@") {
        const name = (/^@([A-Za-z-]+)/.exec(css.slice(i, stop))?.[1] ?? "").toLowerCase();
        if (GROUPING_AT_RULES.has(name)) rules(stop + 1, close, `@${name}`);
      } else {
        const kind = rootSelectorKind(css.slice(i, stop));
        if (kind.root) declarations_(stop + 1, close, { atRule, exclusive: kind.exclusive });
      }
      i = close + 1;
    }
  };

  rules(0, len, null);
  return { declarations, endsClean: clean };
}

/** Every declaration of a custom property in a top-level (or at-rule nested) `:root`/`html` rule, in order. */
export function findRootVarDeclarations(css: string): RootVarDeclaration[] {
  return scanRootVars(css).declarations;
}

/** `css` with one declaration's value replaced; every other byte kept. */
export function replaceValue(css: string, decl: Pick<RootVarDeclaration, "valueStart" | "valueEnd">, value: string): string {
  return css.slice(0, decl.valueStart) + value + css.slice(decl.valueEnd);
}

/**
 * `css` with a new `:root { ... }` block after its last rule (before trailing whitespace), or
 * null when the text does not end cleanly — the block would land inside an open comment or
 * rule and never apply.
 */
export function appendRootBlock(css: string, values: ReadonlyArray<readonly [string, string]>): string | null {
  if (values.length === 0) return css;
  if (!scanRootVars(css).endsClean) return null;
  // Written in the file's own line endings, so a CRLF file does not come back mixed.
  const eol = css.includes("\r\n") ? "\r\n" : "\n";
  const body = values.map(([name, value]) => `  ${name}: ${value};${eol}`).join("");
  const block = `:root {${eol}${body}}`;
  let cut = css.length;
  while (cut > 0 && WS.test(css[cut - 1]!)) cut--;
  const head = css.slice(0, cut);
  const tail = css.slice(cut);
  return `${head}${head ? eol + eol : ""}${block}${tail || eol}`;
}
