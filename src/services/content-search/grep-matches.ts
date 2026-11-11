/**
 * The grep fallback's match columns and replacements. GNU grep reports which
 * lines match but not where, so the host finds each match in the line with
 * JavaScript: a case-sensitive literal with `indexOf`, everything else with a
 * `RegExp` of the same pattern. Columns are UTF-16 offsets in the full line.
 *
 * Only rg is exact (design: "rg `--json` is the source of truth"); here a
 * pattern JS cannot compile matches its whole line with no replacement
 * (`replaceAvailable: false` → `SearchResponse.replaceUnavailable`), and a line
 * grep reported but JS finds nothing in is still listed, as a whole-line match.
 */
import type { SearchRequest } from "./search-options.ts";

export interface GrepLineMatch {
  /** 0-based, UTF-16, in the full line. */
  column: number;
  /** UTF-16 length. */
  length: number;
  text: string;
  /** Set when the request had `replace` and the match came from the pattern itself. */
  replacement?: string;
}

export interface GrepMatcher {
  /** False when JavaScript cannot run the pattern: every match is the whole line, with no replacement. */
  replaceAvailable: boolean;
  /** Every match in one line grep reported (without its line ending). */
  matchLine(line: string): GrepLineMatch[];
}

type MatchOptions = Pick<SearchRequest, "query" | "caseSensitive" | "wholeWord" | "regex" | "replace">;

export function createGrepMatcher(req: MatchOptions): GrepMatcher {
  const { query, replace, regex } = req;
  const replacementOf = (m: RegExpMatchArray | string): string | undefined =>
    replace === undefined ? undefined : regex && typeof m !== "string" ? expandReplacement(replace, m) : replace;

  let find: ((line: string) => GrepLineMatch[]) | null;
  if (!regex && req.caseSensitive && !req.wholeWord && query.length > 0) {
    find = (line) => {
      const out: GrepLineMatch[] = [];
      for (let i = line.indexOf(query); i !== -1; i = line.indexOf(query, i + query.length)) {
        out.push(withReplacement({ column: i, length: query.length, text: query }, replacementOf(query)));
      }
      return out;
    };
  } else {
    const re = compile(regex ? query : escapeRegExp(query), req.caseSensitive, req.wholeWord);
    find = re
      ? (line) =>
          Array.from(line.matchAll(re), (m) =>
            withReplacement({ column: m.index!, length: m[0].length, text: m[0] }, replacementOf(m)),
          )
      : null;
  }

  return {
    replaceAvailable: find !== null,
    matchLine(line) {
      const found = find?.(line) ?? [];
      return found.length > 0 ? found : [{ column: 0, length: line.length, text: line }];
    },
  };
}

function withReplacement(match: GrepLineMatch, replacement: string | undefined): GrepLineMatch {
  if (replacement !== undefined) match.replacement = replacement;
  return match;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Unicode mode first (letters with accents count as word characters), then without it, else null. */
function compile(source: string, caseSensitive: boolean, wholeWord: boolean): RegExp | null {
  const flags = caseSensitive ? "g" : "gi";
  for (const unicode of [true, false]) {
    const word = unicode ? "[\\p{L}\\p{N}_]" : "\\w";
    const bounded = wholeWord ? `(?<!${word})(?:${source})(?!${word})` : source;
    try {
      return new RegExp(bounded, unicode ? `${flags}u` : flags);
    } catch {
      // try the next mode
    }
  }
  return null;
}

/** `$$`, `$&`, `$0`, `$1`…`$99`, `$<name>`, `${n}`/`${name}`; a group that did not take part is empty. */
function expandReplacement(template: string, m: RegExpMatchArray): string {
  const groupCount = m.length - 1;
  const group = (key: string): string => {
    if (/^\d+$/.test(key)) return Number(key) <= groupCount ? (m[Number(key)] ?? "") : "";
    return m.groups?.[key] ?? "";
  };
  return template.replace(/\$(\$|&|\d{1,2}|<([^>]*)>|\{([^}]*)\})/g, (all, tok: string, angle?: string, brace?: string) => {
    if (tok === "$") return "$";
    if (tok === "&") return m[0];
    if (angle !== undefined) return group(angle);
    if (brace !== undefined) return group(brace);
    // JS rule: two digits when they name a group, else one digit and the second kept as text.
    if (tok.length === 2 && Number(tok) >= 1 && Number(tok) <= groupCount) return group(tok);
    const d = Number(tok[0]);
    if (d > groupCount) return all;
    return group(tok.charAt(0)) + tok.slice(1);
  });
}
