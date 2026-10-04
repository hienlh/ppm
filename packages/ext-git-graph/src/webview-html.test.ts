/**
 * The Git Graph panel is one HTML string: a stylesheet and a script that no
 * type checker or linter ever sees as code. Most of what can go wrong in it is
 * silent — a renamed id the script no longer finds, an icon that renders as
 * nothing, two numbers for one breakpoint that drift apart — so these tests
 * read the shipped document and hold the pieces that have to agree together.
 */
import { describe, it, expect } from "bun:test";
import { getWebviewHtml } from "./webview-html.ts";
import { WEBVIEW_ICONS } from "./webview-icons.generated.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

const html = getWebviewHtml();
const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
/*
 * The script as shipped. Bun writes every non-ASCII character of a template
 * literal as a \uXXXX escape, and under String.raw that escape is what lands in
 * the text — the same string at run time, a different one to search — so the
 * expectations below match on ASCII only.
 */
const script = html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));

/** The braced block that starts at `opening`, opening included. Throws when it is gone. */
function blockAt(source: string, opening: string, from = 0): string {
  const start = source.indexOf(opening, from);
  if (start === -1) throw new Error(`\`${opening}\` is not in the source`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after \`${opening}\``);
}

/** One function of the shipped script, as source. */
const fn = (name: string): string => blockAt(script, `function ${name}(`);
/** One top-level CSS rule, by its exact selector. */
const rule = (selector: string): string => blockAt(css, `\n${selector} {`);
/** A media or container block, by its exact condition. */
const media = (condition: string): string => blockAt(css, `${condition} {`);

describe("the document", () => {
  it("carries its stylesheet and its one script inline", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html.split("<script").length - 1).toBe(1);
  });

  it("has every region the script fills in", () => {
    for (const id of [
      "toolbar", "op-banner", "gg-main", "graph-area", "graph-container", "graph-header", "commit-list-wrapper",
      "graph-clip", "graph-svg-container", "commit-list", "loading", "graph-pan-bar", "scroll-markers",
      "search-results", "sheet-scrim", "detail-panel", "status-bar", "status-text", "btn-load-more",
      "settings-panel", "menu-scrim", "context-menu", "toast-host",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});

describe("the script", () => {
  it("parses as JavaScript", () => {
    // A template literal is never type-checked: a stray brace ships as a blank
    // panel with one console error. `new Function` parses without running.
    expect(() => new Function(script)).not.toThrow();
  });

  it("contains nothing that would end the script element early", () => {
    expect(script).not.toContain("</script");
    expect(script).not.toContain("<!--");
  });

  it("finds every element it asks for by id", () => {
    // A renamed id is a null the script dereferences on load — the whole panel
    // stops, and nothing in review looks wrong.
    const ids = new Set([...script.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1]!));
    expect(ids.size).toBeGreaterThan(30);
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it("draws only icons that were generated", () => {
    // An unknown name renders as an empty string, i.e. a button with no glyph.
    const used = new Set<string>();
    const literals = (text: string) => [...text.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!);
    for (const m of script.matchAll(/\bic\(([^,)]*)/g)) literals(m[1]!).forEach((n) => used.add(n));
    for (const m of script.matchAll(/\bicon: '([a-z][a-z0-9-]*)'/g)) used.add(m[1]!);
    // Names picked at run time — by a toast's kind, a ref pill's type, the sync
    // button's mode — are the values after each `?` and `:`, not the keys compared.
    for (const m of script.matchAll(/const icons? = ([^;]+);/g)) {
      for (const v of m[1]!.matchAll(/[?:]\s*'([a-z][a-z0-9-]*)'/g)) used.add(v[1]!);
    }
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter((name) => !(name in WEBVIEW_ICONS))).toEqual([]);
  });

  it("never calls prompt, confirm or alert, which a sandboxed frame does not have", () => {
    // They return null in silence there; every answer is collected by markup.
    expect(script).not.toMatch(/(?<![\w.$])(?:window\.)?(?:prompt|confirm|alert)\s*\(/);
  });

  it("hands links to the app, and only web ones", () => {
    const open = fn("openExternal");
    expect(open).toContain("/^https?:\\/\\//i.test(");
    expect(open).toContain("command: '__ppm.openExternal'");
    expect(script).toContain("e.target.closest('a[href]')");
  });

  it("agrees with the stylesheet about every breakpoint it asks about", () => {
    // Each width is written twice — once for the script, once for the CSS —
    // and a mismatch leaves a band of widths where the two disagree about
    // what is on screen.
    expect(fn("isNarrowLayout")).toContain("'(max-width: 640px)'");
    expect(css).toContain("@media (max-width: 640px) {");
    // The inspector is a column from 901px: the CSS overlays it at 900 and below.
    expect(fn("isColumnLayout")).toContain("'(min-width: 901px)'");
    expect(media("@media (max-width: 900px)")).toContain("#detail-panel { position: absolute;");
    // The toolbar drops its three list buttons at 700, and the View menu takes them in.
    expect(fn("viewMenuItems")).toContain("'(max-width: 700px)'");
    expect(media("@media (max-width: 700px)")).toContain("#toolbar .opt");
  });
});

describe("the toolbar", () => {
  it("has the scope, find, list, sync and view controls", () => {
    for (const id of [
      "branch-selector", "scope-label", "find-bar", "find-input", "find-count", "find-prev", "find-next",
      "find-close", "find-mode", "btn-stash", "btn-worktree", "btn-submodule", "sync", "btn-fetch",
      "btn-pull", "btn-push", "btn-sync-m", "btn-find", "btn-view", "btn-inspector",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("keeps refresh and settings in the View menu rather than as buttons of their own", () => {
    expect(html).not.toContain('id="btn-refresh"');
    expect(html).not.toContain('id="btn-settings"');
    const view = fn("viewMenuItems");
    expect(view).toContain("label: 'Refresh', icon: 'sync', action: reloadEverything");
    expect(view).toContain("label: 'Git Graph settings");
    expect(view).toContain("icon: 'settings', action: openSettings");
  });

  it("collapses fetch, pull and push into one button on a phone", () => {
    const phone = media("@media (max-width: 640px)");
    expect(phone).toContain("#sync");
    expect(phone).toContain("#btn-sync-m, #btn-find { display: inline-flex; }");
  });

  it("shows a list's count only when there is one", () => {
    expect(css).toContain(".tool .n:empty { display: none; }");
  });

  it("keeps a closed settings panel out of the Tab order, not only off-screen", () => {
    expect(css).toMatch(/#settings-panel \{[^}]*transform: translateX\(105%\); visibility: hidden;/);
    expect(css).toMatch(/#settings-panel\.open \{[^}]*visibility: visible;/);
  });
});

describe("the theme", () => {
  it("takes dark from the host attribute, not only from the OS", () => {
    // The panel is a sandboxed iframe: prefers-color-scheme reports the
    // desktop's setting, which has nothing to do with the app's theme.
    expect(css).toContain(':root[data-ppm-theme="dark"] {');
  });

  it("never lets the OS media query override an explicit light", () => {
    const os = media("@media (prefers-color-scheme: dark)");
    expect(os).toContain(':root:not([data-ppm-theme="light"])');
    expect(/@media \(prefers-color-scheme: dark\) \{\s*:root \{/.test(css)).toBe(false);
  });

  it("derives the hover surface from the text colour", () => {
    // Some app themes give both panel surfaces one colour; a hover mapped from
    // either would be invisible in exactly those themes.
    expect(css).toContain("--surface-hover: color-mix(in srgb, var(--text)");
  });

  it("gives the host's tokens the specificity to win", () => {
    // webview-theme.ts appends ":root[data-ppm-theme]" last and wins the tie
    // on source order — only while no panel rule is more specific than that.
    expect(css).not.toContain("html[data-ppm-theme");
    expect(css).not.toContain(':root[data-ppm-theme="dark"][');
  });

  it("draws the checked-out branch in the accent and every other lane in a hue that is not a status", () => {
    // Green, red and yellow already mean added, deleted and modified here.
    expect(css).toContain("--ln-0: var(--accent);");
    const lanes = [...css.matchAll(/--ln-[1-4]: ([^;]+);/g)].map((m) => m[1]!);
    expect(lanes.length).toBeGreaterThanOrEqual(4);
    for (const lane of lanes) expect(lane).not.toMatch(/--(green|red|yellow)/);
    // The lane the head is on is swapped with lane 0, whatever index the layout gave it.
    const laneVar = fn("laneVar");
    expect(laneVar).toContain("if (k === gHeadColour) k = 0;");
    expect(laneVar).toContain("else if (k === 0) k = gHeadColour;");
  });
});

describe("the graph", () => {
  it("draws one shape per kind of row", () => {
    const draw = blockAt(script, "draw(svg, config) {", script.indexOf("class GVertex"));
    expect(draw).toContain("this.isWip ? 'wip' : this.isStash ? 'stash' : this._isCurrent ? 'head' : this.isMerge() ? 'merge' : 'commit'");
    for (const kind of ["commit", "merge", "head", "wip"]) expect(draw).toContain(`kind === '${kind}'`);
    // Nothing is fetched to draw a node.
    expect(script).not.toContain("gravatar");
    expect(draw).not.toContain("'image'");
  });

  it("colours lines and nodes through style, because an attribute cannot hold var()", () => {
    expect(fn("svgEl")).toContain("el.style[k] = style[k]");
    expect(script).toContain("{ class: solid ? 'line' : 'line dash', d: path }, { stroke: colour }");
  });

  it("dashes a stash's lane and the line out of the uncommitted changes", () => {
    expect(script).toContain("GBranch._drawPath(svg, curPath, pxLines[i - 1].isC && !this._isStash, colour)");
    expect(css).toContain("#graph-svg-container path.dash { stroke-dasharray: 3 3; }");
  });

  it("draws the grid at the height the rows really have", () => {
    // Under browser zoom a row is fractional, and a rounded grid drifts the
    // nodes off their rows by the bottom of the list.
    const render = fn("graphRender");
    expect(render).toContain("const rowH = measuredRowHeight() || graphConfig.grid.y;");
    expect(render).toContain("grid: { ...graphConfig.grid, y: rowH, offsetY: rowH / 2 }");
  });
});

describe("the rows", () => {
  /** The cells the static header declares, in order. */
  function headerOrder(): string[] {
    const header = html.slice(html.indexOf('id="graph-header"'), html.indexOf('id="commit-list-wrapper"'));
    return [...header.matchAll(/<div class="(col-[a-z]+)">/g)].map((m) => m[1]!);
  }

  /** The cells renderCommitList appends to a row, in order, by the class each was given. */
  function rowOrder(): string[] {
    const build = fn("renderCommitList");
    const classOf = new Map(
      [...build.matchAll(/(\w+)\.className = '(col-[a-z]+)'/g)].map((m) => [m[1]!, m[2]!] as const),
    );
    return [...build.matchAll(/row\.appendChild\((\w+)\)/g)].map((m) => classOf.get(m[1]!) ?? m[1]!);
  }

  it("builds every row in the order the header labels it", () => {
    // Two places declare this order; a column added to one and not the other
    // puts every label over the wrong cell, and nothing throws.
    expect(headerOrder()).toEqual(["col-graph", "col-message", "col-changes", "col-author", "col-date", "col-hash"]);
    expect(rowOrder()).toEqual(headerOrder());
  });

  it("layers hover, a search match and the selection in that order", () => {
    // The row you clicked should look selected even when it is also a match,
    // and no state rule may be qualified by an id, which would outrank the rest.
    const hover = css.indexOf(".commit-row:hover {");
    const match = css.indexOf(".commit-row.search-match {");
    const selected = css.indexOf(".commit-row.selected {");
    expect(hover).toBeGreaterThan(-1);
    expect(hover).toBeLessThan(match);
    expect(match).toBeLessThan(selected);
    expect(css).not.toMatch(/#commit-list \.commit-row[:.]/);
  });

  it("puts the scroll markers beside the scroller rather than inside it", () => {
    // Inside #graph-container they would scroll away with the rows.
    const scroller = html.slice(html.indexOf('id="graph-container"'), html.indexOf('id="loading"'));
    expect(scroller).not.toContain("scroll-markers");
    const area = html.slice(html.indexOf('id="graph-area"'), html.indexOf('id="sheet-scrim"'));
    expect(area).toContain('id="scroll-markers"');
  });

  it("fills the lines-changed column in place instead of rebuilding every row", () => {
    // A rebuild would drop the scroll position and the open inspector, and
    // the numbers arrive a moment after the rows are already on screen.
    const handler = script.slice(script.indexOf("case 'loadCommitStats':"), script.indexOf("case 'commitDetails':"));
    expect(handler).toContain("applyCommitStats()");
    expect(handler).not.toContain("renderCommitList()");
  });

  it("updates the uncommitted row in place on the five-second poll", () => {
    // Rebuilding the list every five seconds would reset the scroll and redraw the graph.
    const onChanges = fn("onChangesUpdated");
    expect(onChanges).toContain("else updateWipRow();");
    expect(fn("updateWipRow")).toContain("if (sig === wipRowSig) return;");
  });

  it("gives the uncommitted row a second line on a phone, with the file count the Author column carried", () => {
    // One line cut "0 of 4 blocks staged" off mid-word, and the hidden Author column took the file count with it.
    // Bun ships the middle dot as an escape, so match around it.
    expect(fn("wipMessageHtml")).toMatch(/'<span class="wip-files"> \S+ ' \+ escHtml\(plural\(t\.files, 'file'\)\)/);
    expect(css).toContain(".wip-files { display: none; }");
    const phone = media("@media (max-width: 640px)");
    expect(phone).toContain(".commit-row.wip .msg-subject { flex: 1 1 100%; }");
    expect(phone).toContain(".commit-row.wip .wip-meta .segs { display: none; }");
    expect(phone).toContain(".wip-files { display: inline; }");
  });

  it("gives every tick box a thumb-sized target on a phone", () => {
    expect(rule(".cb-cell")).toContain("width: 30px;");
    const phone = media("@media (max-width: 640px)");
    expect(phone).toContain(".sc-row { min-height: 56px; }");
    expect(phone).toContain(".cb-cell { width: 48px; }");
    expect(phone).toContain(".linkbtn { height: 44px; }");
    // The header's 1px top border comes out of its height; the select-all box gets the rest.
    expect(rule(".sc-lh")).toContain("border-top: 1px solid");
    expect(phone).toContain(".sc-lh { height: 45px; }");
  });

  it("reaches 44px to tap on the controls the design draws smaller on a phone", () => {
    const phone = media("@media (max-width: 640px)");
    // 36px tall, minus a 1px border each side, plus 5px each side: 44.
    expect(phone).toContain(".gg-scope, .sc-sync { height: 36px; }");
    expect(phone).toContain(".gg-scope::after, .sc-sync::after { content: \"\"; position: absolute; inset: -5px 0; }");
    // 22px tall, minus the border, plus 12px each side: 44.
    expect(rule(".hash")).toContain("height: 22px;");
    expect(phone).toContain(".gi-meta .hash::after { content: \"\"; position: absolute; inset: -12px -2px; }");
    expect(phone).toContain(".gg-scope, .sc-sync, .gi-meta .hash { position: relative; }");
    // The find bar: the box is the input's label, and its buttons are real 44px squares.
    expect(html).toMatch(/<label class="gg-find">[\s\S]*?<input id="find-input"/);
    expect(phone).toContain("#toolbar.find-open .gg-find { height: 46px; }");
    expect(phone).toContain("#toolbar.find-open .gg-find .clear, #toolbar.find-open .gg-find .step { width: 44px; height: 44px; }");
    expect(phone).toContain("#toolbar.find-open .gg-find .mode::after { content: \"\"; position: absolute; inset: -12px 0; }");
  });

  it("says how many commits matched while the phone's find box is open", () => {
    // The 420px tier hides the count for a box squeezed between other buttons; open on a phone it is alone.
    expect(media("@media (max-width: 420px)")).toContain(".gg-find .count { display: none; }");
    expect(media("@media (max-width: 640px)")).toContain("#toolbar.find-open .gg-find .count:not(:empty) { display: inline; }");
    const phone = media("@media (max-width: 640px)");
    // A short form beside four 44px buttons and the mode chip; the long one stays readable to a screen reader.
    expect(fn("setFindCount")).toContain("'<span class=\"long\">' + escHtml(text) + '</span><span class=\"short\" aria-hidden=\"true\">' + escHtml(short || text) + '</span>'");
    expect(css).toContain(".gg-find .count .short { display: none; }");
    expect(phone).toContain("#toolbar.find-open .gg-find .count .short { display: inline; }");
    expect(phone).toMatch(/#toolbar\.find-open \.gg-find \.count \.long \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\);/);
    expect(fn("doSearch")).toContain("setFindCount(q ? (found ? found + ' found' : 'none') : '', found ? String(found) : 'none');");
    expect(script).toContain("setFindCount((state.searchIndex + 1) + ' of ' + n, (state.searchIndex + 1) + '/' + n);");
  });

  it("keeps the current match marked on a phone, where a closed sheet otherwise clears the selection", () => {
    // Stepping selects the match without opening the sheet; unmarked, it was the one match that did not stand out.
    expect(rule(".commit-row.selected")).toContain("box-shadow: inset 2px 0 0 var(--accent);");
    const phone = media("@media (max-width: 640px)");
    expect(phone).toContain(".insp-closed .commit-row.selected:not(.find-current) { background: none; box-shadow: none; }");
    expect(phone).not.toContain(".insp-closed .commit-row.selected { background: none;");
    // Keyed on the step, not on matching: a row selected before the search that also matches
    // showed as the current match while the count still read "4", not "1/4".
    expect(phone).not.toContain(":not(.search-match)");
    // Unmarked, that row keeps the tint every other match has, not a bare background.
    const tint = rule(".commit-row.search-match").match(/background: ([^;]+);/)![1];
    expect(phone).toContain(".insp-closed .commit-row.selected.search-match:not(.find-current) { background: " + tint + "; }");
    expect(fn("applySearchToRows")).toContain("row.classList.toggle('find-current', hit && row.dataset.hash === current);");
    expect(fn("applySearchToRows")).toContain("const current = state.searchIndex >= 0 ? state.searchMatches[state.searchIndex] : null;");
    expect(fn("navigateSearch")).toContain("r.classList.toggle('find-current', r.dataset.hash === hash)");
  });

  it("shows the find count's short form only where the phone's box is open", () => {
    // Every caller that sets a count must also say how it reads on a phone, or the phone shows the long one.
    const calls = [...script.matchAll(/setFindCount\(([^;]*)\);/g)].map((m) => m[1]!).filter((args) => args !== "''");
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const args of calls) expect(args).toMatch(/, /);
  });

  it("leaves a file row's 24px tools to the long-press menu on a phone, which has both of them", () => {
    expect(media("@media (max-width: 640px)")).toContain(".sc-row .acts { display: none; }");
    const menu = fn("wipFileMenuItems");
    expect(menu).toContain("label: 'Open file'");
    expect(menu).toContain("label: 'Discard changes");
    expect(fn("inspectorMenuTarget")).toContain("if (f) return (anchor) => openMenu(wipFileMenuItems(f), anchor);");
  });

  it("marks a merge's and a stash's changes as not counted, and never claims zero", () => {
    // git gives a merge no diffstat by default and a stash is not in the log:
    // "+0" would be a wrong fact, and an empty cell would read as still loading.
    expect(fn("fillChangesCell")).toContain("if (!stat) return;");
    expect(script).toMatch(/const NOT_COUNTED = '<span class="muted">[^<]+<\/span>';/);
    const render = fn("renderCommitList");
    const stash = render.slice(render.indexOf("} else if (isStash) {"), render.indexOf("} else {", render.indexOf("} else if (isStash) {")));
    expect(stash).toContain("changesCol.innerHTML = NOT_COUNTED;");
    expect(render).toContain("if (commit.parents.length > 1) {\n        changesCol.innerHTML = NOT_COUNTED;");
  });

  it("says who made a stash and when, as a commit row does", () => {
    const render = fn("renderCommitList");
    const stash = render.slice(render.indexOf("} else if (isStash) {"), render.indexOf("} else {", render.indexOf("} else if (isStash) {")));
    expect(stash).toContain("avatarFor(commit.author, commit.authorEmail)");
    expect(stash).toContain("dateCol.textContent = formatDate(commit.commitDate);");
    expect(fn("getDisplayCommits")).toContain("commitDate: s.date || 0");
  });
});

describe("the columns", () => {
  it("offers every optional column in Settings, in the script and in the stylesheet", () => {
    const keys = Object.keys(DEFAULT_SETTINGS).filter((k) => /^col[A-Z]/.test(k));
    const optional = script.slice(script.indexOf("const OPTIONAL_COLUMNS = ["), script.indexOf("];", script.indexOf("const OPTIONAL_COLUMNS = [")));
    expect(keys.length).toBe(4);
    for (const key of keys) {
      const col = key.slice(3).toLowerCase();
      expect(html).toContain(`id="s-${key}"`);
      expect(optional).toContain(`{ key: '${key}', cls: 'cols-no-${col}'`);
      expect(css).toContain(`.cols-no-${col} .col-${col} { display: none; }`);
    }
  });

  it("marks a column the list's width already took away, at the width the stylesheet takes it", () => {
    // The tiers are container queries on the list; the menu has to name the
    // same widths, or a tick does nothing with nothing to say why.
    const hiddenAt = new Map<string, number>();
    for (const m of css.matchAll(/@container graphlist \(max-width: (\d+)px\) \{/g)) {
      const tier = blockAt(css, m[0], m.index);
      for (const hit of tier.matchAll(/^\s*\.col-([a-z]+) \{ display: none; \}/gm)) hiddenAt.set(hit[1]!, Number(m[1]));
    }
    const blocked = new Map(
      [...fn("columnBlockedByWidth").matchAll(/key === 'col([A-Z][a-z]+)'\) return w <= (\d+);/g)]
        .map((m) => [m[1]!.toLowerCase(), Number(m[2])] as const),
    );
    expect(hiddenAt.size).toBeGreaterThanOrEqual(2);
    expect(blocked).toEqual(hiddenAt);
    expect(fn("columnMenuItems")).toContain("needs a wider panel'");
    // Measured on the list, which an open inspector narrows and the window does not.
    expect(css).toContain("container: graphlist / inline-size;");
    expect(fn("columnBlockedByWidth")).toContain("document.getElementById('graph-container')");
  });

  it("opens the same column list from the header, by right-click or long press", () => {
    expect(script).toContain("header.addEventListener('contextmenu'");
    expect(script).toContain("setupLongPress(header, (x, y) => showColumnMenu(x, y))");
  });

  it("hands a hidden column's width to the graph", () => {
    // No resize fires for a hidden column, so the cap would keep its room.
    expect(fn("applyColumnVisibility")).toContain("applyGraphColWidth()");
  });
});

describe("a list narrower than the table", () => {
  it("caps the graph column against what the other columns measure", () => {
    // The message is the only column that shrinks; from about twenty parallel
    // branches on it used to pay for the graph — all of it, down to zero.
    const cap = fn("graphColCap");
    expect(cap).toContain("'.col-changes, .col-author, .col-date, .col-hash'");
    expect(cap).toContain("fixed += cell.offsetWidth");
    expect(cap).toContain("area.clientWidth - fixed - rowPadding - MESSAGE_MIN_W");
    expect(fn("applyGraphColWidth")).toContain("Math.min(want || GRAPH_MIN_W, cap)");
  });

  it("uses one number for the message column's floor in the CSS and in the cap", () => {
    const cssFloor = /\.col-message \{[^}]*min-width: (\d+)px/.exec(css)?.[1];
    const jsFloor = /const MESSAGE_MIN_W = (\d+);/.exec(script)?.[1];
    expect(cssFloor).toBeDefined();
    expect(cssFloor).toBe(jsFloor);
    // The cap leaves the row's own gap and padding too, as the stylesheet sets them.
    const row = rule(".commit-row");
    expect(row).toContain(`gap: ${/const ROW_GAP = (\d+);/.exec(script)?.[1]}px`);
    expect(row).toContain(`padding-right: ${/const ROW_PAD = (\d+);/.exec(script)?.[1]}px`);
  });

  it("recomputes the cap when the list changes size", () => {
    expect(script).toContain("new ResizeObserver(() => applyGraphColWidth()).observe(document.getElementById('graph-container'))");
  });

  it("clips the graph to its column", () => {
    // The overlay is positioned and the rows are not, so unclipped it paints
    // branch lines through the messages.
    const clip = rule("#graph-clip");
    expect(clip).toContain("width: var(--graph-col-w");
    expect(clip).toContain("overflow: hidden");
    expect(html).toContain('<div id="graph-clip"><div id="graph-svg-container"></div></div>');
  });

  it("pans what does not fit by dragging it, with a hint that takes no room", () => {
    expect(rule("#graph-pan-bar")).toContain("position: absolute");
    expect(rule("#graph-pan-bar")).toContain("pointer-events: none");
    expect(rule("#graph-svg-container")).toContain("transform: translateX(calc(-1 * var(--graph-pan-x, 0px)))");
  });

  it("leaves vertical scrolling to the browser and takes only a sideways drag", () => {
    expect(css).toContain(".commit-row:not(.header-row) .col-graph { align-self: stretch; touch-action: pan-y; }");
    expect(script).toContain("Math.abs(dx) < 4 || Math.abs(dx) <= Math.abs(e.clientY - startY)");
  });

  it("does not open the commit a drag happened to end on", () => {
    const click = script.slice(script.indexOf("list.addEventListener('click', (e) => {\n    if (!panned) return;"));
    expect(click.slice(0, 200)).toContain("e.stopPropagation()");
    expect(click.slice(0, 200)).toContain("}, true)");
  });

  it("drops the message's floor on a phone, where the row is the message", () => {
    expect(media("@media (max-width: 640px)")).toContain(".col-message { min-width: 0; }");
  });

  it("never holds the table open and scrolls it sideways", () => {
    expect(css).not.toContain("min-width: 880px");
  });
});

describe("the inspector", () => {
  const detail = fn("renderDetailPanel");

  it("is a column on a wide panel, a panel over the list below that, and a bottom sheet on a phone", () => {
    expect(rule("#gg-main")).toContain("grid-template-columns: minmax(0, 1fr) var(--gg-inspector-w)");
    expect(media("@media (max-width: 900px)")).toContain("#detail-panel { position: absolute;");
    const phone = media("@media (max-width: 640px)");
    expect(phone).toContain("#detail-panel { position: fixed; top: auto; left: 0; right: 0; bottom: 0;");
    expect(phone).toContain(".detail-panel .grab { display: flex;");
  });

  it("closes the same way from its button, the scrim and Escape", () => {
    for (const view of ["renderDetailPanel", "renderStashPanel", "renderWipPanel"]) expect(fn(view)).toContain("CLOSE_BUTTON");
    expect(script).toContain("if (e.target.closest('.detail-close')) { e.stopPropagation(); closeDetailPanel(); return; }");
    expect(script).toContain("document.getElementById('sheet-scrim').addEventListener('click', closeDetailPanel)");
    expect(script).toContain("if (state.inspectorOpen) closeDetailPanel();");
  });

  it("draws each file with the app's icon for its type, asked for once the rows are in", () => {
    expect(fn("renderFileListHtml")).toContain("fileIconHtml(f.path)");
    expect(fn("wipFileRowHtml")).toContain("fileIconHtml(file.path)");
    for (const [view, insert] of [
      ["renderDetailPanel", "panel.innerHTML ="],
      ["renderStashPanel", "panel.innerHTML ="],
      ["updateWipPanel", "getElementById('wip-list').innerHTML ="],
    ] as const) {
      const body = fn(view);
      expect(body.indexOf(insert)).toBeGreaterThan(-1);
      expect(body.indexOf("requestFileIcons();")).toBeGreaterThan(body.indexOf(insert));
    }
    expect(script).toContain("case '__ppm.fileIcons':");
    // The span has no content, so without a size of its own it is nothing at all.
    expect(rule(".vsi")).toContain("display: inline-block; flex: none; width: 16px; height: 16px;");
  });

  it("lists the same six fields every time, in the same order", () => {
    // A field that comes and goes cannot be found by muscle memory, and a
    // rebase or an amend is exactly what makes the two dates differ.
    const order = [
      "metaRow('Commit'", "metaRow(parentCount > 1 ? 'Parents' : 'Parent'", "metaRow('Author'",
      "metaRow('Author date'", "metaRow('Committer'", "metaRow('Commit date'",
    ].map((call) => detail.indexOf(call));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(detail).toContain("whenCell(detail.authorDate)");
    expect(detail).toContain("whenCell(detail.commitDate)");
  });

  it("says which timezone a time is in, with options Intl accepts together", () => {
    // dateStyle or timeStyle plus timeZoneName is a TypeError, which behind a
    // catch looks exactly like a locale with no zone to give.
    const format = blockAt(script, "const WHEN_FORMAT = {");
    expect(format).not.toContain("dateStyle");
    expect(format).not.toContain("timeStyle");
    const options = new Function(`return ${format.slice(format.indexOf("{"))}`)();
    expect(new Date(1_788_943_142_000).toLocaleString(undefined, options)).toMatch(/GMT|UTC/);
  });

  it("sets the body as blocks, reflowing only the ones that were wrapped", () => {
    const body = fn("messageBodyHtml");
    expect(body).toContain("splitCommitBody(body)");
    expect(body).toContain("'<p class=\"msg-p\">'");
    expect(body).toContain("'<pre class=\"msg-pre\">'");
    expect(rule(".msg-p")).not.toContain("--mono-font");
    expect(rule(".msg-pre")).toContain("var(--mono-font)");
    // The reset zeroed every margin, so the blocks space themselves.
    expect(css).toMatch(/\.msg-p \+ \.msg-p[^{]*\{[^}]*margin-top/);
  });

  it("copies any value it shows through one delegate, as git wants it back", () => {
    expect(script).toContain("const copySource = e.target.closest('[data-copy]');");
    expect(fn("personCell")).toContain("name + ' <' + email + '>'");
    expect(fn("hashCell")).toContain("String(hash).slice(0, 8)");
    expect(rule(".hash-lead")).toContain("var(--text)");
  });

  it("puts a file's name first and cuts its folder from the start", () => {
    // In a narrow column the part of a path that tells two files apart is its end.
    const name = fn("nameAndDir");
    expect(name.indexOf("'<b>' + name")).toBeLessThan(name.indexOf('<small class="sx">'));
    expect(rule(".sx")).toContain("direction: rtl");
  });

  it("isolates every start-ellipsized path, or its punctuation lands at the wrong end", () => {
    // Outside an isolate the "." of ".gitignore" takes the box's right-to-left
    // direction and renders as "gitignore.".
    const uses = [...script.matchAll(/class="sx">(.{0,5})/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const next of uses) expect(next).toBe("<bdi>");
  });

  it("builds the uncommitted view once and then updates it in parts", () => {
    // The changes are read every five seconds; a rebuild would take the cursor
    // out of the message box someone is typing in.
    expect(fn("renderWipPanel")).toContain("if (panel.dataset.view !== 'wip') {");
    expect(fn("updateWipPanel")).toContain("if (sig !== wipFilesSig) {");
    expect(fn("applyDraft")).toContain("if (Date.now() - state.draftEditedAt < 3000) return;");
  });

  it("asks git for a commit's files and draws what the row already knows meanwhile", () => {
    expect(fn("renderInspector")).toContain("renderDetailPanel(partialDetail(commit))");
    expect(fn("receiveDetail")).toContain("if (!detail || detail.hash !== state.selectedCommit) return;");
  });
});

describe("touch", () => {
  it("disarms a long press on touchcancel, which is all a scroll sends", () => {
    expect(fn("setupLongPress")).toContain("el.addEventListener('touchcancel'");
  });

  it("hides row actions behind hover only where there is a hover", () => {
    const hidden = css.indexOf(".sc-row .acts { opacity: 0; }");
    expect(hidden).toBeGreaterThan(-1);
    expect(blockAt(css, "@media (hover: hover)", css.lastIndexOf("@media (hover: hover)", hidden))).toContain(".sc-row .acts { opacity: 0; }");
  });

  it("gives a phone 44px targets", () => {
    const phone = media("@media (max-width: 640px)");
    expect(phone).toContain(".tool { width: 44px; height: 44px;");
    expect(phone).toContain(".dialog-actions .btn { width: 100%; height: 44px; }");
    expect(phone).toContain(".op-banner .acts .btn { flex: 1 1 0; height: 44px;");
    expect(phone).toContain(".menu.as-sheet .mi { min-height: 48px;");
  });

  it("declares the phone block after the coarse-pointer one it has to beat", () => {
    expect(css.indexOf("@media (pointer: coarse)")).toBeLessThan(css.indexOf("@media (max-width: 640px)"));
  });
});

describe("answers from the host", () => {
  const onMessage = script.slice(script.indexOf("window.addEventListener('message'"));

  it("hands each answer to the request that asked, and reports one nobody waited on", () => {
    const answer = onMessage.slice(onMessage.indexOf("case 'actionResult':"), onMessage.indexOf("case 'error':"));
    // By the request's id, which the host echoes: two of one action can finish in either order.
    expect(answer).toContain("const cb = takePending(msg.action, msg.reqId);");
    // null was asked for and deliberately unanswered (the silent fetch).
    expect(answer).toContain("else if (cb === undefined && !result.ok) showActionError(");
  });

  it("fails the waiting request when the host could not even start it", () => {
    const error = onMessage.slice(onMessage.indexOf("case 'error':"));
    expect(error).toContain("const cb = takePending(msg.failed, msg.reqId);");
    expect(error).toContain("cb({ ok: false, error: msg.message }, msg)");
  });
});
