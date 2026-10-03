/**
 * Arrays read from Postgres with a NULL element kept apart from the text "NULL".
 *
 * postgres.js (3.4.8, and 3.4.9 alike) hands an unquoted NULL inside an array to the element's
 * parser as the text "NULL": `{a,NULL}` read as ["a", "NULL"], a bool[]'s NULL as false, an int[]'s
 * as NaN and a bytea[]'s as empty bytes. Nothing reports it, and everything that writes a value the
 * grid read — Copy as SQL, the export, the save of an edited array — then writes the wrong one.
 *
 * postgres.js registers one parser per array type on `options.parsers` as a connection first opens,
 * marks it `array`, and from then on hands it the text without its first character. `keepArrayNulls`
 * catches each one as it is set and puts one in its place that reads the array's structure itself,
 * leaving every element that is not NULL to the parser postgres.js made, so it reads as before.
 */

type Parser = (text: string) => unknown;

/** `box[]` is the one array type Postgres separates with `;`: a box is written with commas. */
const BOX_ARRAY_OID = 1020;

/**
 * An array as Postgres prints it — `{1,NULL,"a b"}`, nested `{{1},{2}}`, and `[0:1]={…}` when its
 * bounds are not the default — with each element that is not NULL read by `element`. Throws on
 * text Postgres would not print.
 */
export function parsePostgresArray(text: string, element: Parser, delimiter = ","): unknown[] {
  let i = text.startsWith("[") ? text.indexOf("=") + 1 : 0;
  const fail = (): never => {
    throw new Error(`Not an array as Postgres prints one: ${text.slice(0, 80)}`);
  };
  const list = (): unknown[] => {
    if (text[i] !== "{") fail();
    i++;
    const items: unknown[] = [];
    if (text[i] === "}") {
      i++;
      return items;
    }
    for (;;) {
      if (text[i] === "{") {
        items.push(list());
      } else if (text[i] === '"') {
        let value = "";
        for (i++; text[i] !== '"'; i++) {
          if (i >= text.length) fail();
          if (text[i] === "\\") i++;
          value += text[i];
        }
        i++;
        items.push(element(value));
      } else {
        const start = i;
        while (i < text.length && text[i] !== delimiter && text[i] !== "}") i++;
        const raw = text.slice(start, i);
        // Postgres quotes an element that is the word NULL, so a bare one is always the NULL value.
        items.push(raw.toUpperCase() === "NULL" ? null : element(raw));
      }
      if (text[i] === delimiter) i++;
      else if (text[i] === "}") {
        i++;
        return items;
      } else fail();
    }
  };
  const items = list();
  if (i !== text.length) fail();
  return items;
}

/** Puts a NULL-aware parser in place of each array parser postgres.js sets on `parsers`. */
export function keepArrayNulls(parsers: Record<number, Parser>): void {
  const proto = Object.getPrototypeOf(parsers) as object | null;
  Object.setPrototypeOf(parsers, new Proxy(proto ?? Object.create(null), {
    // Only a key `parsers` does not hold yet reaches here: postgres.js adding an array type.
    set: (target, key, value, receiver) =>
      Reflect.set(target, key, typeof value === "function" ? nullAware(value as Parser, Number(key)) : value, receiver),
  }));
}

function nullAware(original: Parser, oid: number): Parser {
  let array = false;
  const delimiter = oid === BOX_ARRAY_OID ? ";" : ",";
  // postgres.js's own parser reads one element when handed it alone, quoted, as the rest of an array.
  const element = (text: string) => (original(`"${text.replace(/[\\"]/g, "\\$&")}"}`) as unknown[])[0];
  const parse = (text: string): unknown => {
    if (!array) return original(text);
    try {
      return parsePostgresArray(text, element, delimiter);
    } catch {
      return original(text.slice(1));
    }
  };
  // Marked as an array, postgres.js would cut the text's first character off for it; this parser
  // reads the whole text, `[0:1]={…}` included, so it keeps the mark to itself.
  Object.defineProperty(parse, "array", {
    get: () => false,
    set: (marked: unknown) => {
      array = marked === true;
    },
  });
  return parse;
}
