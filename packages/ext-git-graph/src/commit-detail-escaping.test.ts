/**
 * Everything the commit details panel renders comes out of a repository, and a
 * repository is something you clone from someone else. An author name, an
 * email, a refname and a file path are all attacker-controllable in a repo you
 * did not write, and the panel puts every one of them into `innerHTML`.
 *
 * The code was already correct. What was missing was anything that would notice
 * if it stopped being: replacing the author line with its unescaped form left
 * the whole suite green. So this file does two things — it runs the shipped
 * cell renderers against hostile input, and it asserts at the source level that
 * no field reaches the markup without going through `escHtml` first.
 *
 * The functions are taken out of the *shipped* script rather than imported,
 * because the shipped script is a string: an import would prove a copy correct.
 */
import { describe, it, expect } from "bun:test";
import { getWebviewHtml } from "./webview-html.ts";

const SCRIPT = (() => {
  const html = getWebviewHtml();
  const open = html.lastIndexOf("<script>");
  const close = html.lastIndexOf("</script>");
  return html.slice(open + "<script>".length, close);
})();

/**
 * One top-level declaration, as source.
 *
 * A brace counter is enough here and would not be in general: nothing this file
 * reaches for has a `{` or `}` inside a string literal. A declaration that is
 * not found, or one whose braces never balance, throws — which is the behaviour
 * worth having, because the alternative is a test that silently starts checking
 * nothing after a rename.
 */
function declarationSource(opening: string): string {
  const start = SCRIPT.indexOf(opening);
  if (start === -1) throw new Error(`no \`${opening}\` in the shipped script`);
  let depth = 0;
  for (let i = SCRIPT.indexOf("{", start); i < SCRIPT.length; i++) {
    if (SCRIPT[i] === "{") depth++;
    else if (SCRIPT[i] === "}" && --depth === 0) return SCRIPT.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after \`${opening}\``);
}

const functionSource = (name: string): string => declarationSource(`function ${name}(`);

const NAMES = ["escHtml", "copyable", "hashCell", "personCell", "whenCell", "metaRow"] as const;

interface Cells {
  escHtml(value: unknown): string;
  copyable(inner: string, text: string, cls: string): string;
  hashCell(hash: string): string;
  personCell(name: string, email: string): string;
  whenCell(ts: number): string;
  metaRow(label: string, cells: string[]): string;
}

/**
 * `Date` is a parameter of the sandbox so a test can hand `whenCell` a locale
 * that returns something dangerous. Driven by the real one it cannot fail: a
 * formatted date holds no `<`, so the assertion passes with the escape taken
 * out — which is the same "green against the bug" this file exists to end.
 */
function buildCells(dateCtor: typeof Date = Date): Cells {
  return new Function(
    "Date",
    `
  ${declarationSource("const WHEN_FORMAT = {")}
  ${NAMES.map(functionSource).join("\n")}
  return { ${NAMES.join(", ")} };
`,
  )(dateCtor) as Cells;
}

const cells = buildCells();

/** The shape of the thing this panel has to survive being handed. */
const HOSTILE = '<img src=x onerror="alert(1)">';

describe("the detail panel's cells escape what the repository gave them", () => {
  it("escapes a hostile commit hash, in the visible half and the copy target", () => {
    const html = cells.hashCell(HOSTILE);

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('data-copy="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"');
  });

  it("escapes the tail of a hash, not only its first eight characters", () => {
    // The first eight characters are styled separately from the rest, so both
    // halves have to be escaped — an unescaped tail is just as live. A payload
    // starting at index 0 cannot show that: it lands entirely in the lead, and
    // dropping the tail's `escHtml` leaves every assertion above green. This
    // one starts exactly where the tail does.
    const html = cells.hashCell(`01234567${HOSTILE}`);

    expect(html).toContain('<span class="hash-lead">01234567</span>');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes an author's name and email, and the copy target built from both", () => {
    const html = cells.personCell(HOSTILE, "ada</span><script>alert(1)</script>");

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a quote, which is what breaks out of an attribute", () => {
    // `data-copy="…"` is the attribute a quote would escape from, and it holds
    // the raw value rather than the styled one.
    const html = cells.copyable("inner", 'x" onmouseover="alert(1)', "mono");

    expect(html).toContain("&quot;");
    expect(html).not.toContain('" onmouseover="');
  });

  it("escapes a row label, which is the one field the panel writes itself", () => {
    expect(cells.metaRow(HOSTILE, ["<b>cell</b>"])).not.toContain("<img");
    // The cells are already-rendered HTML and must not be escaped again.
    expect(cells.metaRow("Author", ["<b>cell</b>"])).toContain("<b>cell</b>");
  });

  it("wraps a formatted date in the row's own span", () => {
    expect(cells.whenCell(1_700_000_000)).toContain('<span class="meta-when">');
  });

  it("escapes a formatted date, which is locale data rather than repository data", () => {
    // Not attacker-controllable, but it goes through the same door and the rule
    // is easier to keep than to remember exceptions to. The locale is faked
    // because a real formatted date contains nothing that needs escaping.
    class HostileLocale {
      toLocaleString(): string {
        return HOSTILE;
      }
    }
    const faked = buildCells(HostileLocale as unknown as typeof Date);

    expect(faked.whenCell(1_700_000_000)).not.toContain("<img");
    expect(faked.whenCell(1_700_000_000)).toContain("&lt;img");
  });

  it("escapes a bare ampersand once, not twice", () => {
    // Double-escaping is the other failure mode, and it is silent: a commit by
    // "Ada &amp; Co" reads as literal `&amp;` rather than as an injection.
    expect(cells.escHtml("Ada & Co")).toBe("Ada &amp; Co");
    expect(cells.escHtml(cells.escHtml("Ada & Co"))).toBe("Ada &amp;amp; Co");
  });
});

/**
 * Two more renderers put repository text into markup outside the detail grid:
 * a ref pill (every branch and tag name, in the list and in the inspector) and
 * a changed file's row. Run for real, with the helpers they call taken from the
 * same shipped script.
 */
function buildRows(): {
  refPillHtml(ref: { name: string; type: string; synced?: boolean }): string;
  wipFileRowHtml(file: Record<string, unknown>): string;
  fileIconHtml(path: string): string;
} {
  const helpers = [
    "escHtml", "plural", "splitPath", "fileCheckState", "changeLetter", "changeCounts", "lineNote", "blockAnchor", "blockDots",
    "hasUnstaged", "countsHtml", "statusTile", "nameAndDir", "checkboxHtml", "dotsHtml", "headAhead",
    "fileIconHtml", "refPillHtml", "wipFileRowHtml",
  ];
  return new Function(`
  const state = { changes: null, currentBranch: "" };
  const fileIconClasses = new Map();
  function ic() { return ""; }
  ${declarationSource("const STATUS_NAMES = {")}
  ${helpers.map(functionSource).join("\n")}
  return { refPillHtml, wipFileRowHtml, fileIconHtml };
`)() as ReturnType<typeof buildRows>;
}

const rows = buildRows();

describe("ref pills and changed-file rows escape what the repository gave them", () => {
  it("escapes a branch name in the pill's text, its data attribute and its title", () => {
    // `<` and `>` are legal in a ref name, so a cloned repository can ship one.
    const html = rows.refPillHtml({ name: HOSTILE, type: "local" });

    expect(html).not.toContain("<img");
    expect(html).toContain('data-ref="&lt;img');
  });

  it("escapes a ref type, which reaches an attribute too", () => {
    const html = rows.refPillHtml({ name: "main", type: '"><img src=x onerror=alert(1)>' });

    expect(html).not.toContain("<img");
  });

  it("escapes a changed file's path everywhere the row uses it", () => {
    const side = { blocks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }], added: 1, removed: 1 };
    const html = rows.wipFileRowHtml({
      path: `src/${HOSTILE}/a.ts`, x: " ", y: "M", untracked: false, conflict: false, staged: null, unstaged: side,
    });

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes a file name in the attribute its icon is asked for by", () => {
    const html = rows.fileIconHtml(`src/${HOSTILE}`);

    expect(html).not.toContain("<img");
    expect(html).toContain('data-fi="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"');
  });
});

describe("no field reaches the panel's markup unescaped", () => {
  /**
   * The behavioural tests above cover the cells. This covers the renderers
   * around them, where a field is concatenated straight into a string and the
   * mistake is a missing call rather than a wrong one.
   *
   * The operator is `\+=?` rather than `\+`, because half of this markup is
   * built by appending: `head += detail.author` is the same defect as
   * `head + detail.author` and the narrower pattern walks straight past it.
   */
  function rawInterpolations(name: string, field: RegExp): string[] {
    const pattern = new RegExp(`\\+=? *(${field.source})\\b(?!\\s*\\?)`, "g");
    return [...functionSource(name).matchAll(pattern)].map((match) => match[1]!);
  }

  /** Numbers — counted by the panel or parsed by the host — not text from the repository. */
  const counted = (expression: string) => !expression.endsWith(".length") && !expression.endsWith(".index")
    && expression !== "f.additions" && expression !== "f.deletions";

  it("renderDetailPanel interpolates no `detail.*` value directly", () => {
    expect(rawInterpolations("renderDetailPanel", /detail\.\w+(?:\.\w+)?/).filter(counted)).toEqual([]);
  });

  it("renderStashPanel interpolates no stash or detail value directly", () => {
    expect(rawInterpolations("renderStashPanel", /detail\.\w+(?:\.\w+)?|stash\.\w+|parts\.\w+|ref|base|when/).filter(counted)).toEqual([]);
  });

  it("the file list interpolates no file field directly", () => {
    // A path is repository-supplied and lands in three attributes and the text.
    expect(rawInterpolations("renderFileListHtml", /f\.\w+|hash|parentHash/).filter(counted)).toEqual([]);
    expect(rawInterpolations("filesSectionHtml", /detail\.\w+(?:\.\w+)?/).filter(counted)).toEqual([]);
    expect(rawInterpolations("nameAndDir", /path|parts\[\d\]/)).toEqual([]);
  });

  it("a changed file's row interpolates no file field directly", () => {
    expect(rawInterpolations("wipFileRowHtml", /file\.\w+/)).toEqual([]);
  });

  it("a ref pill interpolates no ref field directly", () => {
    expect(rawInterpolations("refPillHtml", /ref\.\w+/)).toEqual([]);
  });

  it("a history search result interpolates no hit field directly", () => {
    expect(rawInterpolations("renderSearchResults", /h\.\w+(?:\.\w+)?/)).toEqual([]);
  });
});
