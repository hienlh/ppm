import { describe, it, expect } from "bun:test";
import { formatCommitMessage, splitCommitBody, COMMIT_MESSAGE_JS } from "./commit-message-html.ts";

/** The default rule the graph ships with, and the one that caused the bug. */
const ISSUE_RULE = [{ pattern: "#(\\d+)", url: "" }];

describe("formatCommitMessage", () => {
  it("leaves an apostrophe alone with the issue rule active", () => {
    // The bug: escaping first turned this into "Monaco&#39;s", then `#(\d+)`
    // matched the "39" and split the entity, so the row showed `&#39;`.
    const html = formatCommitMessage("unregister Monaco's bundled TypeScript service", ISSUE_RULE);
    expect(html).toBe("unregister Monaco&#39;s bundled TypeScript service");
    expect(html).not.toContain("commit-link");
  });

  it("still links a real issue reference", () => {
    const html = formatCommitMessage("fix #39 for good", ISSUE_RULE);
    expect(html).toBe('fix <span class="commit-link" title="#39">#39</span> for good');
  });

  it("links an issue through a url template with its capture groups", () => {
    const html = formatCommitMessage("closes #42", [{ pattern: "#(\\d+)", url: "https://x.test/i/$1" }]);
    expect(html).toContain('href="https://x.test/i/42"');
    expect(html).toContain(">#42</a>");
    expect(html).toContain('rel="noreferrer"');
  });

  it("escapes every other entity-forming character too", () => {
    const html = formatCommitMessage('a & b < c > d "e"', ISSUE_RULE);
    expect(html).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("cannot be made to inject markup from a commit message", () => {
    const html = formatCommitMessage('<img src=x onerror=alert(1)>', ISSUE_RULE);
    expect(html).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("cannot be made to break out of a link's href", () => {
    // Matching raw text means the href is the only place a quote could land.
    const html = formatCommitMessage('see http://x.test/a"onmouseover="alert(1)', []);
    expect(html).not.toContain('"onmouseover="');
    expect(html).toContain("&quot;onmouseover=&quot;");
  });

  it("keeps a URL atomic instead of linking what is inside it", () => {
    const html = formatCommitMessage("see https://x.test/pull/39#c/deadbeef1 now", ISSUE_RULE);
    expect(html).toBe(
      'see <a class="commit-link" href="https://x.test/pull/39#c/deadbeef1"'
      + ' target="_blank" rel="noreferrer">https://x.test/pull/39#c/deadbeef1</a> now',
    );
  });

  it("marks a bare commit hash", () => {
    const html = formatCommitMessage("reverts 8abb115 as agreed", []);
    expect(html).toBe('reverts <span class="commit-link" title="8abb115">8abb115</span> as agreed');
  });

  it("gives the first claim on a range to the rule that ran first", () => {
    // "deadbeef" is both a hash and, here, an issue pattern. The rule wins,
    // because rules run before the hash sweep.
    const html = formatCommitMessage("deadbeef", [{ pattern: "deadbeef", url: "https://x.test/$0" }]);
    expect((html.match(/commit-link/g) || []).length).toBe(1);
    expect(html).toContain("<a ");
  });

  it("skips an invalid pattern rather than losing the message", () => {
    const html = formatCommitMessage("keep me", [{ pattern: "(unclosed", url: "" }]);
    expect(html).toBe("keep me");
  });

  it("skips a pattern long enough to be a backtracking bomb", () => {
    const html = formatCommitMessage("keep me", [{ pattern: "a".repeat(201), url: "" }]);
    expect(html).toBe("keep me");
  });

  it("does not hang or emit empty spans for a pattern that matches nothing", () => {
    const html = formatCommitMessage("abc", [{ pattern: "x*", url: "" }]);
    expect(html).toBe("abc");
  });

  it("handles an empty or missing message", () => {
    expect(formatCommitMessage("", ISSUE_RULE)).toBe("");
    expect(formatCommitMessage(undefined as unknown as string, ISSUE_RULE)).toBe("");
  });
});

describe("COMMIT_MESSAGE_JS", () => {
  it("is the same function, and reads the rules off the webview's state", () => {
    // The webview gets the formatter as source. Evaluating it here is what
    // proves the shipped copy behaves like the one tested above.
    const evaluate = new Function(
      "state",
      `${COMMIT_MESSAGE_JS}; return formatCommitMessage;`,
    ) as (state: unknown) => (msg: string) => string;

    const withRule = evaluate({ settings: { issueLinkingRules: ISSUE_RULE } });
    expect(withRule("unregister Monaco's service")).toBe("unregister Monaco&#39;s service");
    expect(withRule("fix #39")).toContain('title="#39"');

    // No settings at all must not throw — the panel renders before they load.
    const bare = evaluate({});
    expect(bare("plain 'message'")).toBe("plain &#39;message&#39;");
  });
});

describe("splitCommitBody", () => {
  const NL = "\n";

  it("reflows a paragraph its author wrapped at 72 columns", () => {
    const body = [
      "Extensions could not activate at all when PPM ran from a compiled binary.",
      "Toggling one off and on again reported that the worker had been terminated,",
      "and on startup activation timed out after ten seconds.",
    ].join(NL);
    expect(splitCommitBody(body)).toEqual([{
      kind: "prose",
      text: "Extensions could not activate at all when PPM ran from a compiled binary. "
        + "Toggling one off and on again reported that the worker had been terminated, "
        + "and on startup activation timed out after ten seconds.",
    }]);
  });

  it("leaves a bulleted list exactly as it was written", () => {
    // Joining these would run three items into one sentence.
    const body = ["- the first item, which wraps", "  onto a second line", "- the second item here too"].join(NL);
    expect(splitCommitBody(body)).toEqual([{ kind: "pre", text: body }]);
  });

  it("leaves short lines alone even though nothing marks them", () => {
    // The give-away that the breaks are meaningful is that the lines are
    // nowhere near the block's longest — wrapped prose fills all but one.
    const body = ["Before: 33.3 MB", "After: 1.08 MB"].join(NL);
    expect(splitCommitBody(body)).toEqual([{ kind: "pre", text: body }]);
  });

  it("does not reflow a paragraph with one deliberately short line in it", () => {
    const body = [
      "This first line runs all the way out to the usual seventy-two columns ok",
      "short",
      "and this last one is long again out to about seventy-two columns as well",
    ].join(NL);
    expect(splitCommitBody(body)[0]!.kind).toBe("pre");
  });

  it("splits on blank lines and judges each paragraph on its own", () => {
    const body = [
      "A first paragraph that was wrapped by its author at about seventy columns",
      "and continues onto a second line here.",
      "",
      "- a list that follows it",
      "- and must not be reflowed",
    ].join(NL);
    expect(splitCommitBody(body).map((b) => b.kind)).toEqual(["prose", "pre"]);
  });

  it("keeps a fence, a quote, a heading and a table verbatim", () => {
    for (const first of ["```js", "> quoted text here", "# A heading", "| a | b |"]) {
      const body = [first, "something else that is long enough to look like wrapped prose"].join(NL);
      expect(splitCommitBody(body)[0]!.kind).toBe("pre");
    }
  });

  it("treats an indented block as verbatim", () => {
    const body = ["    indented like code, and long enough to look like wrapped prose", "    a second line"].join(NL);
    expect(splitCommitBody(body)[0]!.kind).toBe("pre");
  });

  it("drops trailing blank lines rather than emitting empty blocks", () => {
    expect(splitCommitBody("one line only" + NL + NL + NL)).toEqual([{ kind: "pre", text: "one line only" }]);
    expect(splitCommitBody("")).toEqual([]);
    expect(splitCommitBody(null as unknown as string)).toEqual([]);
  });

  it("normalises CRLF, so a message written on Windows reflows too", () => {
    const body = "A line long enough to have been wrapped at seventy-two columns\r\n"
      + "and a second line that continues the same sentence to its end.";
    const [block] = splitCommitBody(body);
    expect(block!.kind).toBe("prose");
    expect(block!.text).not.toContain("\r");
  });

  it("ships to the webview as source, like the formatter", () => {
    // Same reason: one copy, typed and tested here, injected by toString().
    expect(COMMIT_MESSAGE_JS).toContain("const splitCommitBody =");
    expect(() => new Function(COMMIT_MESSAGE_JS)).not.toThrow();
  });
});
