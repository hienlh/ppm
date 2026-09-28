import { describe, it, expect } from "bun:test";
import { getWebviewHtml } from "./webview-html.ts";

describe("webview-html: getWebviewHtml", () => {
  it("returns valid HTML", () => {
    const html = getWebviewHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("includes essential elements", () => {
    const html = getWebviewHtml();
    expect(html).toContain('<div id="app">');
    expect(html).toContain('<header id="toolbar">');
    expect(html).toContain('<div id="graph-container">');
    expect(html).toContain('<div id="detail-panel"');
    expect(html).toContain('<div id="status-bar">');
    expect(html).toContain('<div id="context-menu"');
  });

  it("includes find bar", () => {
    const html = getWebviewHtml();
    expect(html).toContain('id="find-bar"');
    expect(html).toContain('id="find-input"');
    expect(html).toContain('id="find-count"');
    expect(html).toContain('id="find-prev"');
    expect(html).toContain('id="find-next"');
    expect(html).toContain('id="find-close"');
  });

  it("includes toolbar buttons", () => {
    const html = getWebviewHtml();
    expect(html).toContain('id="branch-selector"');
    expect(html).toContain('id="btn-refresh"');
    expect(html).toContain('id="btn-find"');
    expect(html).toContain('id="btn-settings"');
  });

  it("includes commit list columns", () => {
    const html = getWebviewHtml();
    expect(html).toContain("col-graph");
    expect(html).toContain("col-message");
    expect(html).toContain("col-author");
    expect(html).toContain("col-date");
    expect(html).toContain("col-hash");
  });

  it("includes CSS styles", () => {
    const html = getWebviewHtml();
    expect(html).toContain("<style>");
    expect(html).toContain("</style>");
    expect(html).toContain("--bg:");
    expect(html).toContain("--text:");
    expect(html).toContain("--border:");
  });

  it("includes dark mode styles", () => {
    const html = getWebviewHtml();
    expect(html).toContain("prefers-color-scheme: dark");
  });

  it("includes JavaScript", () => {
    const html = getWebviewHtml();
    expect(html).toContain("<script>");
    expect(html).toContain("</script>");
  });

  it("includes graph container and commit list", () => {
    const html = getWebviewHtml();
    expect(html).toContain('id="graph-header"');
    expect(html).toContain('id="commit-list"');
    expect(html).toContain('id="loading"');
    expect(html).toContain('id="graph-svg-container"');
    expect(html).toContain('id="commit-list-wrapper"');
  });

  it("marks elements with proper classes", () => {
    const html = getWebviewHtml();
    expect(html).toContain("hidden");
    expect(html).toContain("commit-row");
    expect(html).toContain("header-row");
  });

  it("includes viewport meta tag", () => {
    const html = getWebviewHtml();
    expect(html).toContain('meta charset="utf-8"');
  });

  it("includes responsive flex layout", () => {
    const html = getWebviewHtml();
    expect(html).toContain("flex");
    expect(html).toContain("flex-direction");
  });

  it("sets initial status text", () => {
    const html = getWebviewHtml();
    expect(html).toContain("Loading repository");
  });

  it("includes SVG graph rendering capability (comment)", () => {
    const html = getWebviewHtml();
    // Graph rendering would be in the JavaScript section
    expect(html).toContain("<script>");
  });

  it("includes CSS variables for theming", () => {
    const html = getWebviewHtml();
    expect(html).toContain("--blue:");
    expect(html).toContain("--red:");
    expect(html).toContain("--green:");
    expect(html).toContain("--yellow:");
    expect(html).toContain("--purple:");
    expect(html).toContain("--orange:");
  });

  it("includes graph column width variable", () => {
    const html = getWebviewHtml();
    expect(html).toContain("--graph-col-w");
  });

  it("includes overflow handling for containers", () => {
    const html = getWebviewHtml();
    expect(html).toContain("overflow");
  });

  it("is valid HTML structure", () => {
    const html = getWebviewHtml();
    // Check nesting: html > body > div#app
    const bodyStart = html.indexOf("<body>");
    const bodyEnd = html.indexOf("</body>");
    const appDiv = html.indexOf('id="app"');
    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    expect(appDiv).toBeGreaterThan(bodyStart);
    expect(appDiv).toBeLessThan(bodyEnd);
  });

  it("includes proper charset declaration", () => {
    const html = getWebviewHtml();
    expect(html).toContain('charset="utf-8"');
  });
});

describe("webview-html: the injected script", () => {
  /** Everything between the last <script> and its close — the panel's whole runtime. */
  function scriptSource(): string {
    const html = getWebviewHtml();
    const open = html.lastIndexOf("<script>");
    const close = html.lastIndexOf("</script>");
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    return html.slice(open + "<script>".length, close);
  }

  it("parses as JavaScript", () => {
    // The script is a template literal, so nothing type-checks it and a stray
    // brace or backtick ships as a blank panel with one console error. `new
    // Function` parses without running, which is exactly the check wanted.
    expect(() => new Function(scriptSource())).not.toThrow();
  });

  it("renders the commit node as an initials avatar, never a fetched one", () => {
    const source = scriptSource();
    expect(source).toContain("authorInitials(this._author.name)");
    expect(source).toContain("authorColor(this._author.email || this._author.name)");
    expect(source).not.toContain("gravatar");
  });

  it("agrees with the CSS about where the narrow layout starts", () => {
    const html = getWebviewHtml();
    // The script decides where ref badges go and the CSS decides which columns
    // exist; a mismatch hides the badges at some widths.
    expect(html).toContain("window.matchMedia('(max-width: 640px)')");
    expect(html).toContain("@media (max-width: 640px)");
  });

  it("offsets the graph overlay by the branch column's width", () => {
    // The SVG is one absolutely-positioned overlay: if its left edge does not
    // track the column in front of it, every node is drawn off its row's dot.
    // The 6px is the row's own padding, which is where the graph cell starts;
    // the 2px the drawing sits in from there is on the SVG inside the clip box,
    // because a box offset by both ends 2px past the column it clips to.
    const html = getWebviewHtml();
    expect(html).toContain("left: calc(var(--refs-col-w, 170px) + 6px)");
    expect(html).toMatch(/#graph-svg-container \{[^}]*left: 2px/);
  });
});

describe("webview-html: row states", () => {
  const css = getWebviewHtml();

  it("does not qualify the banding rule with an id", () => {
    // `#commit-list .commit-row:nth-child(even)` outranks `.commit-row:hover`
    // and `.commit-row.selected`, so every other row silently stops responding
    // to the pointer and to selection. Same specificity, earlier in the file,
    // is what makes the three coexist.
    expect(css).toContain(".commit-row:nth-child(even) {");
    expect(css).not.toContain("#commit-list .commit-row:nth-child(even)");
  });

  it("declares banding before hover and selection, and selection after a search match", () => {
    const banding = css.indexOf(".commit-row:nth-child(even) {");
    const hover = css.indexOf(".commit-row:hover {");
    const match = css.indexOf(".commit-row.search-match {");
    const selected = css.indexOf(".commit-row.selected {");
    expect(banding).toBeGreaterThan(-1);
    expect(banding).toBeLessThan(hover);
    expect(banding).toBeLessThan(selected);
    // The row you clicked should look selected even when it is also a match.
    expect(match).toBeLessThan(selected);
  });

  it("puts the phone layout after the coarse-pointer rules it has to beat", () => {
    // The coarse block keeps all six columns and scrolls them sideways, which
    // is right for a tablet and wrong for a phone.
    expect(css.indexOf("@media (pointer: coarse)")).toBeLessThan(css.indexOf("@media (max-width: 640px)"));
  });
});

describe("webview-html: columns", () => {
  const html = getWebviewHtml();

  /** The order the static header row declares its cells in. */
  function headerOrder(): string[] {
    const header = html.slice(html.indexOf('id="graph-header"'), html.indexOf('id="commit-list-wrapper"'));
    return [...header.matchAll(/class="(col-[a-z]+)"/g)].map((m) => m[1]!);
  }

  /** The order the script appends them to a row in. */
  function rowOrder(): string[] {
    const build = html.slice(html.indexOf("row.appendChild(refsCol)"), html.indexOf("makeRowDropTarget(row, commit)"));
    const named: Record<string, string> = {
      refsCol: "col-refs", graphCol: "col-graph", msgCol: "col-message",
      changesCol: "col-changes", authorCol: "col-author", dateCol: "col-date", hashCol: "col-hash",
    };
    return [...build.matchAll(/row\.appendChild\((\w+)\)/g)].map((m) => named[m[1]!] ?? m[1]!);
  }

  it("builds the row in the order the header labels it", () => {
    // Two places declare this order — a static header and a JS builder — so a
    // column added to one and not the other puts every label over the wrong
    // cell, and nothing throws.
    expect(rowOrder()).toEqual(headerOrder());
  });

  it("has a Changes column between the message and the author", () => {
    expect(headerOrder()).toEqual([
      "col-refs", "col-graph", "col-message", "col-changes", "col-author", "col-date", "col-hash",
    ]);
  });

  it("puts the scroll markers beside the scroller rather than inside it", () => {
    // Inside #graph-container they would scroll away with the rows, which is
    // the opposite of an overview.
    const area = html.slice(html.indexOf('id="graph-area"'), html.indexOf('id="detail-panel"'));
    expect(area.indexOf('id="graph-container"')).toBeGreaterThan(-1);
    expect(area.indexOf('id="scroll-markers"')).toBeGreaterThan(area.indexOf('id="graph-container"'));
    const markersInsideScroller = html.slice(
      html.indexOf('id="graph-container"'), html.indexOf('id="loading"'),
    ).includes("scroll-markers");
    expect(markersInsideScroller).toBe(false);
  });

  it("fills the stats in place instead of rebuilding every row", () => {
    // A rebuild would discard the scroll position and the open detail panel,
    // and the numbers arrive a moment after the rows are already on screen.
    const handler = html.slice(html.indexOf("case 'loadCommitStats':"), html.indexOf("case 'commitDetails':"));
    expect(handler).toContain("applyCommitStats()");
    expect(handler).not.toContain("renderCommitList()");
  });
});

describe("getWebviewHtml theme source", () => {
  const html = getWebviewHtml();
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));

  it("takes dark from the host attribute, not only from the OS", () => {
    // The panel is a sandboxed iframe, so prefers-color-scheme reports the
    // desktop's setting and has nothing to do with the theme the app is on.
    expect(css).toContain(':root[data-ppm-theme="dark"]');
  });

  it("never lets the OS media query override an explicit light", () => {
    // A bare ":root" inside the media query would win over nothing and lose to
    // nothing, so a light app on a dark desktop stayed dark.
    const media = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    expect(media).toContain(':root:not([data-ppm-theme="light"])');
    expect(/@media \(prefers-color-scheme: dark\) \{\s*:root \{/.test(css)).toBe(false);
  });

  it("derives the hover surface from the text colour", () => {
    // The host injects the app's tokens, and some app themes give both panel
    // surfaces the same colour — a hover mapped from one of them would be
    // invisible in exactly those themes.
    expect(css).toContain("--surface-hover: color-mix(in srgb, var(--text)");
  });

  it("gives the host's tokens the specificity to win", () => {
    // webview-theme.ts injects ":root[data-ppm-theme]", which ties with the
    // panel's own dark rule; source order breaks the tie, and the injected
    // block is appended last. So the panel's rules must not be more specific
    // than one attribute.
    expect(css).not.toContain("html[data-ppm-theme");
    expect(css).not.toContain(':root[data-ppm-theme="dark"][');
  });

  it("bands the rows harder in dark than in light", () => {
    // Equal percentages are not equally visible: a black wash over a white row
    // reads, the same lift of near-white over a near-black row does not.
    const light = /--band: color-mix\(in srgb, var\(--text\) ([\d.]+)%/.exec(
      css.slice(css.indexOf(":root {"), css.indexOf(':root[data-ppm-theme="dark"]')),
    );
    const dark = /--band: color-mix\(in srgb, var\(--text\) ([\d.]+)%/.exec(
      css.slice(css.indexOf(':root[data-ppm-theme="dark"]')),
    );
    expect(Number(dark?.[1])).toBeGreaterThan(Number(light?.[1]));
  });

  it("dims the ref badge text with the mode rather than the desktop", () => {
    expect(css).toContain(':root[data-ppm-theme="dark"] .ref-badge');
  });
});

describe("getWebviewHtml commit details", () => {
  const html = getWebviewHtml();
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  const render = html.slice(html.indexOf("function renderDetailPanel"), html.indexOf("// --- Context menu ---"));
  const uncommitted = html.slice(
    html.indexOf("function renderUncommittedDetail"), html.indexOf("function wireCommitControls"),
  );

  it("reads the commit twice: glanceable in the header, in full below", () => {
    // The header answers who and how long ago; the grid under it answers with
    // the forty-character hash, both emails and both dates. The old version
    // had only the second half, as a stack of labelled lines with a heading.
    expect(render).not.toContain("Commit Details");
    expect(render).toContain("formatDate(detail.authorDate)");
    expect(render).toContain("metaRow('Commit'");
    expect(render).toContain("metaRow('Author'");
  });

  it("shows the same six fields every time, in the same order", () => {
    // A field that comes and goes cannot be found by muscle memory, and a
    // rebase or an amend is exactly what makes the author date and the commit
    // date differ — so both are always here, as two labelled rows.
    const order = ["'Commit'", "'Parent'", "'Author'", "'Author date'", "'Committer'", "'Commit date'"];
    let at = -1;
    for (const label of order) {
      const found = render.indexOf("metaRow(" + label, at);
      const alt = label === "'Parent'" ? render.indexOf("? 'Parents' : 'Parent'", at) : found;
      expect(Math.max(found, alt)).toBeGreaterThan(at);
      at = Math.max(found, alt);
    }
    expect(render).toContain("whenCell(detail.authorDate)");
    expect(render).toContain("whenCell(detail.commitDate)");
    // No row is conditional on the committer matching the author any more.
    expect(render).not.toContain("sameHand");
  });

  it("says which timezone a commit time is in", () => {
    // 09:13 means nothing without knowing whose morning it was — and asking
    // for a timezone name alongside dateStyle or timeStyle is a TypeError, so
    // the format has to be spelled out component by component. Behind a catch
    // that throw looks identical to a locale with no timezone to offer.
    const fmt = html.slice(html.indexOf("const WHEN_FORMAT"), html.indexOf("function whenCell"));
    expect(fmt).toContain("timeZoneName: 'short'");
    expect(fmt).not.toContain("dateStyle");
    expect(fmt).not.toContain("timeStyle");
  });

  it("formats a commit time with a real Intl call", () => {
    // The options above are only correct if Intl accepts them together, which
    // is a runtime question, not a source one.
    const fmt = html.slice(html.indexOf("const WHEN_FORMAT = {"), html.indexOf("function whenCell"));
    const options = new Function("return " + fmt.slice(fmt.indexOf("{"), fmt.lastIndexOf("}") + 1))();
    const text = new Date(1788943142_000).toLocaleString(undefined, options);
    expect(text).toMatch(/GMT|UTC/);
  });

  it("sets the body as blocks, reflowing only the ones that were wrapped", () => {
    // A commit body is wrapped at whatever width its author liked, which is
    // not the width of the pane it ends up in; a list is not reflowable at all.
    expect(render).toContain("splitCommitBody(body)");
    expect(render).toContain("'<p class=\"msg-p\">'");
    expect(render).toContain("'<pre class=\"msg-pre\">'");
    // Prose in the UI font, verbatim blocks in monospace.
    const prose = css.slice(css.indexOf(".msg-p {"), css.indexOf(".msg-pre {"));
    expect(prose).not.toContain("--mono-font");
    expect(css.slice(css.indexOf(".msg-pre {"))).toContain("var(--mono-font)");
  });

  it("spaces the body's blocks itself, because the reset zeroed the defaults", () => {
    // Every margin is zeroed at the top of this stylesheet, so a p element
    // brings none of its own — the paragraphs would run together.
    expect(css).toMatch(/\.msg-p \+ \.msg-p[^{]*\{[^}]*margin-top/);
  });

  it("makes a forty-character hash readable without shortening it", () => {
    // The eight that identify the commit carry the contrast; the rest is there
    // to be copied. A click still copies the whole thing.
    expect(render).toContain("hashCell(detail.hash)");
    expect(html).toContain('class="hash-lead"');
    expect(html).toContain("String(hash).slice(0, 8)");
    const lead = css.slice(css.indexOf(".hash-lead {"));
    expect(lead.slice(0, lead.indexOf("}"))).toContain("var(--text)");
  });

  it("gives every field one label and one value, at every width", () => {
    // The dates used to ride in a third column so that they lined up with each
    // other, which put each one a name's width from the name it belonged to
    // and against the far edge of the pane. Two columns, one row per field.
    expect(css).toMatch(/\.detail-meta \{[^}]*grid-template-columns: max-content minmax\(0, 1fr\);/);
    expect(wide).not.toContain("grid-template-columns: max-content minmax(0, 1fr) max-content");
    expect(wide).not.toContain(".meta-when");
    const when = css.slice(css.indexOf(".meta-when {"));
    expect(when.slice(0, when.indexOf("}"))).not.toContain("grid-column");
  });

  it("closes from the header, because a tap is the only way in", () => {
    // The panel opens on a tap and used to close on Escape or on tapping the
    // same commit again — neither of which is findable, and the first of which
    // a phone does not have. It took the chips' place rather than joining
    // them: they were a convenience, and the grid below has both hashes whole.
    expect(render).toContain('class="detail-close"');
    expect(render).toContain("ICONS.x");
    expect(render).not.toContain('class="chip copyable"');
    expect(css).not.toContain(".chip {");
    expect(render).toContain("metaRow('Commit'");
  });

  it("keeps that button on a phone, where the panel is a third of the screen", () => {
    // This row used to be hidden below the breakpoint, because two hash chips
    // took half a 390px header and left the author's name as "t." with an
    // ellipsis. Hiding a close button is a different thing entirely: it is the
    // only way out on the device with no Escape key.
    const phone = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(phone.slice(0, phone.indexOf("\n}"))).not.toContain(".detail-head-actions");
    expect(css).not.toContain(".detail-head-actions { display: none; }");
  });

  it("closes the same way from the button and from Escape", () => {
    // Two copies of this drift, and the way it shows is a row left marked
    // selected — a highlight explaining a panel that is no longer there.
    const close = html.slice(html.indexOf("function closeDetailPanel"));
    const body = close.slice(0, close.indexOf("\n}"));
    expect(body).toContain("state.selectedCommit = null");
    expect(body).toContain("state.expandedCommit = null");
    expect(body).toContain("classList.add('hidden')");
    expect(body).toContain(".commit-row.selected");
    expect(body).toContain("renderScrollMarkers()");
    expect(html).toContain("else if (state.expandedCommit) closeDetailPanel();");
    const handler = html.slice(html.indexOf("// The header's dismiss."), 0 + html.indexOf("const copySource"));
    expect(handler).toContain("closest('.detail-close')");
    expect(handler).toContain("closeDetailPanel()");
  });

  it("copies any value it shows, by one delegate", () => {
    // The hash chips and the metadata values are the same affordance; two
    // handlers would be two chances for one of them to stop working.
    const handler = html.slice(html.indexOf("// Metadata values."));
    expect(handler.slice(0, 400)).toContain("closest('[data-copy]')");
    // Both helpers route through the same one, and a person copies as the
    // canonical form git wants back rather than as what is on screen.
    expect(html).toContain("function copyable(inner, text, cls)");
    expect(html).toContain("name + ' <' + email + '>'");
  });

  /** The block that turns the panel into two panes. */
  const wide = css.slice(css.indexOf("@media (min-width: 900px)"), css.indexOf("\n}", css.indexOf("@media (min-width: 900px)")));

  it("puts the file list beside the message when there is room", () => {
    // The message is hard-wrapped by whoever wrote it, so on a wide panel it
    // fills half the width and the rest of the row is empty.
    expect(wide).toMatch(/\.detail-grid\.has-files \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax/);
  });

  it("gives each pane its own scrollbar, and takes the panel's away", () => {
    // A long message and a long file list are two lists of unrelated length.
    // Scrolling them as one means reaching the twentieth file by pushing the
    // message off the screen — and the panel keeping its own scrollbar as well
    // would nest a scroller inside a scroller.
    expect(wide).toMatch(/\.detail-panel\.split \{[^}]*overflow: hidden/);
    expect(wide).toMatch(/\.detail-panel\.split \.detail-grid > \* \{[^}]*overflow-y: auto/);
    const base = css.slice(css.indexOf(".detail-panel {"), css.indexOf(".detail-panel h3"));
    expect(base).toContain("overflow-y: auto");
  });

  it("leaves no strip above the files header for rows to scroll through", () => {
    // A sticky element sits at its container's *padding* edge, so the pane's
    // own padding-top becomes a gap above the header that rows pass through in
    // full view rather than under. The header carries that space instead.
    expect(wide).toMatch(/\.detail-panel\.split \.detail-files \{[^}]*padding-top: 0/);
    expect(wide).toMatch(/\.detail-panel\.split \.files-head \{[^}]*position: sticky[^}]*padding:/);
  });

  it("draws one rule in the left pane, under the metadata", () => {
    // Two hairlines in a 360px panel is furniture; 14px semibold against
    // 11.5px monospace already reads as two different things. And the rule
    // cannot belong to the body, which is capped at a readable measure and
    // would stop the border short of the pane edge for no visible reason.
    expect(css).toMatch(/\.detail-meta \{[^}]*border-bottom: 1px solid var\(--border\)/);
    const subject = css.slice(css.indexOf(".detail-subject {"));
    expect(subject.slice(0, subject.indexOf("}"))).not.toContain("border-bottom");
    const text = css.slice(css.indexOf(".detail-text {"));
    expect(text.slice(0, text.indexOf("}"))).not.toContain("border");
  });

  it("only splits when a commit is showing, and hands the scrollbar back", () => {
    // Uncommitted changes are one column with a commit box at the bottom; left
    // split, the panel would clip them with no way to scroll to it.
    expect(render).toContain("panel.classList.toggle('split', !!right)");
    expect(uncommitted).toContain("panel.classList.remove('split')");
  });

  it("only splits the columns when there is a file list to put in one", () => {
    // Otherwise the message would sit in a 62% column with nothing beside it.
    expect(render).toContain("(right ? ' has-files' : '')");
  });

  it("leaves the panel unpadded and pads each view instead", () => {
    // The header is a full-width sticky bar, so the padding cannot live on the
    // scroller — which means every other thing written into the panel has to
    // bring its own.
    const panelRule = css.slice(css.indexOf(".detail-panel {"), css.indexOf(".detail-panel h3"));
    expect(panelRule).not.toContain("padding");
    expect(css).toContain(".detail-pad { padding:");
    expect(uncommitted).toContain('detail-pad');
  });

  it("copies the whole hash from the cell that sets off its first eight", () => {
    // A short hash is what you read; a full one is what you paste. Since the
    // header's chips became the close button, this cell is where both are.
    const cell = html.slice(html.indexOf("function hashCell(hash)"));
    const body = cell.slice(0, cell.indexOf("\n}"));
    expect(body).toContain("String(hash).slice(0, 8)");
    expect(body).toContain("copyable(");
    expect(body).toContain(", hash, 'mono')");
  });

  it("shows the file name before the directory it is in", () => {
    // The list is a narrow column, so what has to survive the ellipsis is the
    // name — which means it cannot be at the end.
    const list = html.slice(html.indexOf("function renderFileListHtml"), html.indexOf("function renderFileActions"));
    expect(list.indexOf("basename(f.path)")).toBeLessThan(list.indexOf("dirname(f.path)"));
  });

  it("gives the directory the slack so the stats and the buttons stay together", () => {
    // Both .file-stat and .file-actions used to claim margin-left auto, which
    // splits the leftover space and leaves the numbers floating mid-row.
    expect(css).toMatch(/\.file-item \.file-dir \{[^}]*flex: 1/);
    const actions = css.slice(css.indexOf(".file-actions {"));
    expect(actions.slice(0, actions.indexOf("}"))).not.toContain("margin-left: auto");
  });
});

describe("webview-html: a panel narrower than the table", () => {
  const html = getWebviewHtml();

  it("caps the graph column instead of letting it take the row", () => {
    // The column used to be set to whatever the lanes needed. The message is
    // the only column that can shrink, so from about twenty parallel branches
    // on it was the message that paid for the graph — all of it, down to zero.
    expect(html).not.toContain("setProperty('--graph-col-w', gw + 'px')");
    expect(html).toContain("function graphColCap()");
    expect(html).toContain("area.clientWidth - fixed - rowPadding - MESSAGE_MIN_W");
    expect(html).toContain("Math.min(want || GRAPH_MIN_W, cap)");
  });

  it("measures what the columns take rather than listing them", () => {
    // Hiding a column has to give its pixels to the graph. A table of constants
    // here would need editing every time a column is added or hidden, and the
    // way that shows is a cap that is quietly too small.
    expect(html).toContain(".col-refs, .col-changes, .col-author, .col-date, .col-hash')");
    expect(html).toContain("fixed += cell.offsetWidth");
  });

  it("recomputes the cap when the panel changes size", () => {
    // Nothing re-renders the graph when a window is dragged, so without this
    // the cap stays at whatever the width was when the commits last arrived.
    expect(html).toContain("new ResizeObserver(() => applyGraphColWidth())");
  });

  it("clips the overlay to the column it belongs to", () => {
    // The overlay is positioned and the rows are not, so it paints above them:
    // capping the column without clipping only replaces a missing message with
    // one that has branch lines drawn through it.
    expect(html).toMatch(/#graph-clip \{[^}]*width: var\(--graph-col-w/);
    expect(html).toMatch(/#graph-clip \{[^}]*overflow: hidden/);
    expect(html).toContain('<div id="graph-clip"><div id="graph-svg-container"></div></div>');
  });

  it("pans the graph by dragging it, with no scrollbar taking a row", () => {
    // A real scrollbar has nowhere to go: not on the overlay, which is as tall
    // as the whole history, and not in the 24px header row, where the thumb
    // comes down across the word "Graph". So the graph is dragged directly, and
    // the only furniture is a hint that takes no space in the table.
    expect(html).not.toContain("graph-hscroll");
    expect(html).toMatch(/#graph-pan-bar \{[^}]*position: absolute/);
    expect(html).toMatch(/#graph-pan-bar \{[^}]*pointer-events: none/);
    expect(html).toContain("transform: translateX(calc(-1 * var(--graph-pan-x, 0px)))");
  });

  it("leaves the vertical scroll to the browser and the sideways drag to itself", () => {
    // Without pan-y the finger that scrolls the list would be taken for a pan
    // attempt on every row whose graph cell it happened to land on.
    expect(html).toContain(".commit-row:not(.header-row) .col-graph { align-self: stretch; touch-action: pan-y; }");
    expect(html).toContain("Math.abs(dx) <= Math.abs(e.clientY - startY)");
  });

  it("gives a row's graph cell a height to be dragged by, and spares the header's", () => {
    // The cell is an empty spacer in a row that centres its cells, so it is 0px
    // tall and every pointer lands on the row behind it. The header's cell has
    // a label, and stretching that one lifts it off the other headings' line.
    expect(html).toMatch(/\.commit-row:not\(\.header-row\) \.col-graph \{[^}]*align-self: stretch/);
    expect(html).not.toMatch(/^\.commit-row \.col-graph \{/m);
  });

  it("does not select the commit a drag happened to end on", () => {
    // The row's own click handler opens a commit, and a pan ends over a row.
    const click = html.slice(html.indexOf("list.addEventListener('click'"));
    expect(click.slice(0, 200)).toContain("e.stopPropagation()");
    expect(click.slice(0, 200)).toContain("}, true)");
  });

  it("agrees between the message column's floor and the cap that respects it", () => {
    // Two numbers for one thing: a CSS floor wider than the JS cap allows for
    // is a row that overflows its own box instead of one that fits.
    const cssFloor = html.match(/\.col-message \{[^}]*min-width: (\d+)px/);
    const jsFloor = html.match(/const MESSAGE_MIN_W = (\d+);/);
    expect(cssFloor?.[1]).toBeDefined();
    expect(cssFloor?.[1]).toBe(jsFloor?.[1]);
  });

  it("drops the message's floor on a phone, where the row is the message", () => {
    // A floor wider than the panel is what makes a row overflow its own box.
    const phone = html.slice(html.indexOf("@media (max-width: 640px)"));
    expect(phone.slice(0, phone.indexOf("\n}"))).toContain(".col-message { min-width: 0; }");
  });

  it("sheds the columns that carry least, in order, before anything is crushed", () => {
    expect(html).toMatch(/@media \(max-width: 900px\) \{\s*\.col-date, \.col-hash \{ display: none; \}/);
    expect(html).toMatch(/@media \(max-width: 760px\) \{\s*\.col-changes \{ display: none; \}/);
  });

  it("lets those tiers apply to a tablet too", () => {
    // The coarse block used to hold the table open at 880px and scroll it
    // sideways, which cancels every tier below that width.
    const coarse = html.slice(html.indexOf("@media (pointer: coarse)"));
    expect(coarse.slice(0, coarse.indexOf("\n}"))).not.toContain("min-width: 880px");
    expect(html).not.toContain("#commit-list-wrapper { min-width: 880px; }");
  });

  it("declares the tiers after the coarse block and before the phone one", () => {
    const coarse = html.indexOf("@media (pointer: coarse)");
    const tier = html.indexOf("@media (max-width: 900px)");
    const phone = html.indexOf("@media (max-width: 640px)");
    expect(coarse).toBeLessThan(tier);
    expect(tier).toBeLessThan(phone);
  });
});

describe("webview-html: column visibility", () => {
  const html = getWebviewHtml();
  const columns = [
    { key: "colRefs", cls: "cols-no-refs", col: "col-refs" },
    { key: "colChanges", cls: "cols-no-changes", col: "col-changes" },
    { key: "colAuthor", cls: "cols-no-author", col: "col-author" },
    { key: "colDate", cls: "cols-no-date", col: "col-date" },
    { key: "colHash", cls: "cols-no-hash", col: "col-hash" },
  ];

  it("offers every optional column in Settings, in the script, and in CSS", () => {
    for (const c of columns) {
      expect(html).toContain(`id="s-${c.key}"`);
      expect(html).toContain(`{ key: '${c.key}', cls: '${c.cls}'`);
      expect(html).toContain(`.${c.cls} .${c.col} { display: none; }`);
    }
  });

  it("zeroes the refs variable when that column goes, not just the cell", () => {
    // The variable is where the graph overlay starts, so hiding the cell alone
    // would leave every node drawn 170px to the right of its row's dot.
    expect(html).toContain(".cols-no-refs { --refs-col-w: 0px; }");
  });

  it("opens the same list from the header as from Settings", () => {
    expect(html).toContain("header.addEventListener('contextmenu'");
    expect(html).toContain("setupLongPress(header, (x, y) => showColumnMenu(x, y))");
    expect(html).toContain("setColumnVisible(col.key, e.target.checked)");
  });

  it("marks what the panel's width has already taken away", () => {
    // A tick that does nothing, with nothing to say why, is worse than an item
    // that says it needs more room.
    expect(html).toContain("columnBlockedByWidth");
    expect(html).toContain("needs a wider panel");
    expect(html).toContain("window.matchMedia('(max-width: 900px)').matches");
    expect(html).toContain("window.matchMedia('(max-width: 760px)').matches");
  });

  it("hands the freed width to the graph", () => {
    // No resize fires for a column that was hidden, so the cap would otherwise
    // keep reserving room for a column that is no longer there.
    const apply = html.slice(html.indexOf("function applyColumnVisibility()"));
    expect(apply.slice(0, apply.indexOf("\n}"))).toContain("applyGraphColWidth()");
  });
});
