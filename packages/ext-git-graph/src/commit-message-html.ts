/**
 * A commit message, as HTML, with the links a graph row wants in it.
 *
 * The rule that matters: **every pattern is matched against the raw message,
 * and escaping happens only when the answer is emitted.** The previous version
 * escaped first and matched second, which quietly wrecked messages — the
 * default issue rule is `#(\d+)`, an apostrophe escapes to `&#39;`, and so
 * "Monaco's" was rendered as a literal `&#39;s` with `#39` styled as an issue
 * link. Anything that matches digits, `amp`, `quot` or `lt` would do the same.
 *
 * Matches are collected as spans over the raw text and the first claim on a
 * range wins, in the order URL → issue rule → bare hash. URLs go first so that
 * a `#123` or a hex-looking segment inside one cannot be linked separately and
 * split the URL in half.
 *
 * The function is deliberately self-contained: it is injected into the webview
 * by `toString()`, so it may not reference anything in this module's scope.
 * That is also what lets it be tested here rather than by reading HTML back
 * out of a string.
 */

export interface IssueLinkRule {
  /** A JavaScript regular expression source. Applied with `g`. */
  pattern: string;
  /** Target URL with `$1`… replaced by the capture groups. Empty means "highlight, do not link". */
  url?: string;
}

function formatCommitMessageImpl(message: string, rules: IssueLinkRule[]): string {
  const esc = (value: string): string =>
    String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const text = String(message == null ? "" : message);
  const spans: { start: number; end: number; html: string }[] = [];

  const add = (start: number, end: number, html: string): void => {
    if (end <= start) return;
    for (const span of spans) if (start < span.end && end > span.start) return;
    spans.push({ start, end, html });
  };

  // A URL is atomic: linking anything inside one would split it.
  for (const match of text.matchAll(/https?:\/\/[^\s<]+/g)) {
    const url = match[0];
    add(
      match.index,
      match.index + url.length,
      '<a class="commit-link" href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(url) + "</a>",
    );
  }

  for (const rule of rules || []) {
    // 200 is longer than any sane issue pattern and short enough to bound
    // backtracking; the literal is inline because this function is injected by
    // `toString()` and cannot reach a constant in this module's scope.
    if (!rule || !rule.pattern || rule.pattern.length > 200) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "g");
    } catch {
      continue; // an invalid pattern is the user's typo, not a reason to lose the message
    }
    for (const match of text.matchAll(re)) {
      const found = match[0];
      if (rule.url) {
        let href = rule.url;
        for (let group = 1; group < match.length; group++) {
          const value = match[group];
          if (typeof value === "string") href = href.split("$" + group).join(value);
        }
        add(
          match.index,
          match.index + found.length,
          '<a class="commit-link" href="' + esc(href) + '" target="_blank" rel="noreferrer" title="'
            + esc(href) + '">' + esc(found) + "</a>",
        );
      } else {
        add(
          match.index,
          match.index + found.length,
          '<span class="commit-link" title="' + esc(found) + '">' + esc(found) + "</span>",
        );
      }
    }
  }

  // A bare hash in a message ("reverts 8abb115") is worth marking, but it is
  // only ever a highlight: this view cannot know the hash is in this repository.
  for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    const hash = match[0];
    add(
      match.index,
      match.index + hash.length,
      '<span class="commit-link" title="' + esc(hash) + '">' + esc(hash) + "</span>",
    );
  }

  spans.sort((a, b) => a.start - b.start);
  let html = "";
  let at = 0;
  for (const span of spans) {
    html += esc(text.slice(at, span.start)) + span.html;
    at = span.end;
  }
  return html + esc(text.slice(at));
}

/** Exported for tests; the webview gets the same function through `COMMIT_MESSAGE_JS`. */
export const formatCommitMessage = formatCommitMessageImpl;

export interface CommitBodyBlock {
  /** `prose` may be reflowed to the pane; `pre` keeps every break the author typed. */
  kind: "prose" | "pre";
  text: string;
}

/**
 * Split a commit body into blocks, and say which ones are hard-wrapped prose.
 *
 * A commit body is wrapped at whatever width its author liked — 72 columns,
 * usually — so rendering it verbatim in a pane of some other width gives a
 * ragged half-filled column, and rendering it as flowing text destroys the
 * lists and the aligned blocks. So each paragraph is judged on its own.
 *
 * The test for "this was wrapped, and the breaks are not meaningful" is that
 * every line but the last comes close to the block's longest — a hand-written
 * list has short lines throughout, wrapped prose does not. Anything opening
 * with a bullet, a quote, a fence, a heading, a number, a table pipe or an
 * indent is left alone, and so is any block whose longest line is too short to
 * have been wrapped at all.
 *
 * Self-contained for the same reason as the formatter above: it is injected by
 * `toString()`.
 */
function splitCommitBodyImpl(body: string): CommitBodyBlock[] {
  const source = String(body == null ? "" : body).replace(/\r\n?/g, "\n");
  const blocks: CommitBodyBlock[] = [];
  const MIN_WRAP_WIDTH = 40;

  for (const chunk of source.split(/\n[ \t]*\n+/)) {
    if (!chunk.trim()) continue;
    const lines = chunk.replace(/\s+$/, "").split("\n");
    let widest = 0;
    for (const line of lines) if (line.length > widest) widest = line.length;

    const flowing = widest >= MIN_WRAP_WIDTH && lines.every((line, i) => {
      if (!/^\S/.test(line)) return false;
      if (/^([-*+>|#]|\d+[.)])/.test(line)) return false;
      if (line.startsWith("```")) return false;
      // Every line but the last has to look full, or the breaks meant something.
      return i === lines.length - 1 || line.length * 3 >= widest * 2;
    });

    blocks.push(flowing
      ? { kind: "prose", text: lines.map((line) => line.trim()).join(" ") }
      : { kind: "pre", text: lines.join("\n") });
  }
  return blocks;
}

/** Exported for tests; the webview gets the same function through `COMMIT_MESSAGE_JS`. */
export const splitCommitBody = splitCommitBodyImpl;

/**
 * The formatter, as source, for the webview script.
 *
 * `toString()` rather than a second copy in a template literal: one of the two
 * would drift, and regex-heavy code written inside a template literal needs its
 * backslashes doubled, which is its own bug factory.
 */
export const COMMIT_MESSAGE_JS = `
const __formatCommitMessage = ${formatCommitMessageImpl.toString()};
function formatCommitMessage(msg) {
  return __formatCommitMessage(msg, (state.settings && state.settings.issueLinkingRules) || []);
}
const splitCommitBody = ${splitCommitBodyImpl.toString()};
`;
