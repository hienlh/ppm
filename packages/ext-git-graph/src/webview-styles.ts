/**
 * The Git Graph panel's stylesheet.
 *
 * Written in the panel's own token names, which the host fills in from the
 * app's theme (src/web/components/extensions/webview-theme.ts):
 * `--bg` is the app's bg-solid, `--surface` its panel, `--border` its soft
 * border and `--border2` its strong one, `--subtext`/`--subtle` its second and
 * third text colours. The values below are only what a host that says nothing
 * gets.
 *
 * A template literal, so: no backticks anywhere in it, comments included.
 */
import { FONT_TOKENS } from "./webview-shell.ts";

/**
 * Dark values, emitted twice by design: once for the host's attribute and once
 * for the OS media query, which must not override an explicit light. The first
 * line is the shell's own dark palette, kept identical so that a panel opened
 * from the graph sits next to it in the same colours.
 */
const DARK_TOKENS = `
  --bg: #16171c; --surface: #1d1f26; --text: #ecedf0; --subtext: #a2a5b0; --subtle: #6b6f7c;
  --border: #262932; --border2: #383c48; --selected: #1e293b;
  --panel-2: #23252d;
  --shadow-panel: 0 18px 44px -24px rgba(0, 0, 0, 0.72);
  --shadow-float: 0 6px 18px -10px rgba(0, 0, 0, 0.6);
  --surface-hover: color-mix(in srgb, var(--text) 8%, transparent);
  --ln-1: #a68bf2; --ln-2: #f27aa0; --ln-3: #3cc6da; --ln-4: #f58a5c;
  color-scheme: dark;
`;

export function graphStyles(messageMinW: number): string {
  return `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #ffffff; --surface: #f4f4f5; --text: #09090b; --subtext: #71717a; --subtle: #a1a1aa;
  --border: #e4e4e7; --border2: #d4d4d8; --selected: #eff6ff;
  --blue: #3b82f6; --green: #22c55e; --yellow: #eab308; --red: #ef4444;
  --accent: var(--blue); --accent-fg: #ffffff;
  --accent-wash: color-mix(in srgb, var(--accent) 10%, transparent);
  --accent-wash-border: color-mix(in srgb, var(--accent) 26%, transparent);
  --panel: var(--surface); --panel-2: var(--bg);
  --shadow-panel: 0 18px 44px -26px rgba(20, 30, 60, 0.2);
  --shadow-float: 0 6px 18px -12px rgba(20, 30, 60, 0.14);
  /* Derived, never injected: the app has no hover token, and some of its
     themes give both panel surfaces one colour, so a hover mapped from either
     would vanish in exactly those themes. A tint of the text flips with the mode. */
  --surface-hover: color-mix(in srgb, var(--text) 6%, transparent);
  /* Lane hues: the accent for the checked-out branch, then the project-avatar
     hues — never a status colour, which would read as a verdict on a branch. */
  --ln-0: var(--accent); --ln-1: #8e6ad8; --ln-2: #e0507e; --ln-3: #0d9cb0; --ln-4: #e3672f; --ln-5: var(--subtle);
  --gg-row-h: 32px;
  --gg-inspector-w: 380px;
  ${FONT_TOKENS}
  color-scheme: light;
}
:root[data-ppm-theme="dark"] { ${DARK_TOKENS} }
@media (prefers-color-scheme: dark) {
  :root:not([data-ppm-theme="light"]) { ${DARK_TOKENS} }
}

html, body { height: 100%; }
body { font-family: var(--ui-font); font-size: 13px; line-height: 1.4; background: var(--bg); color: var(--text); overflow: hidden; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: none; border: 0; cursor: pointer; text-align: inherit; }
button:disabled { cursor: default; }
input[type=text], input[type=number], select { height: 28px; padding: 0 8px; border: 1px solid var(--border2); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 12.5px; outline: none; }
input[type=text]:focus, input[type=number]:focus, select:focus, textarea:focus { border-color: var(--accent); }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 1px; }
.hidden { display: none !important; }
.grow { flex: 1; }
.muted { color: var(--subtle); }
.mono { font-family: var(--mono-font); }
.scroll-thin { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--text) 18%, transparent) transparent; }

#app { display: flex; flex-direction: column; height: 100%; min-height: 0; }

/* ---------- primitives ---------- */
.ic { display: inline-block; flex: none; width: 16px; height: 16px; vertical-align: middle; fill: currentColor; }
.ic-sm { width: 14px; height: 14px; }
/* A file's own icon: the app's vscode-icons artwork, whose classes the app hands over. */
.vsi { display: inline-block; flex: none; width: 16px; height: 16px; background-position: center; background-repeat: no-repeat; background-size: contain; }
.ic-xs { width: 12px; height: 12px; }
.spin { animation: gg-spin 0.8s linear infinite; }
@keyframes gg-spin { to { transform: rotate(360deg); } }

/* The status letter, on a faint tint of its colour (Source Control's colours). */
.st { display: inline-grid; place-items: center; flex: none; width: 18px; height: 18px; border-radius: 5px; font: 600 10.5px/1 var(--mono-font); }
.st-A { color: var(--green); background: color-mix(in srgb, var(--green) 14%, transparent); }
.st-M { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 14%, transparent); }
.st-D, .st-U { color: var(--red); background: color-mix(in srgb, var(--red) 14%, transparent); }
.st-R, .st-C { color: var(--accent); background: var(--accent-wash); }

.cnt { display: inline-flex; gap: 5px; font: 500 11px/1 var(--mono-font); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cnt .a { color: var(--green); }
.cnt .d { color: var(--red); }
.note { font: 500 11px/1 var(--ui-font); color: var(--subtle); white-space: nowrap; }

.avatar { display: inline-grid; place-items: center; flex: none; width: 18px; height: 18px; border-radius: 50%; color: #fff; font: 700 8px/1 var(--ui-font); letter-spacing: -0.02em; }
.avatar.lg { width: 28px; height: 28px; font-size: 10.5px; }
.stash-badge { color: var(--subtext); background: var(--panel-2); border: 1px solid var(--border2); }
.wip-badge { color: var(--accent); background: var(--accent-wash); border: 1px dashed var(--accent-wash-border); }

/* A path that ellipsizes from its start, so the end that differs stays visible. */
.sx { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; min-width: 0; }

/* Ref pills. One quiet shape; only the checked-out branch is tinted. */
.ref { display: inline-flex; align-items: center; gap: 4px; flex: none; max-width: 200px; height: 18px; padding: 0 6px 0 5px; border: 1px solid var(--border2); border-radius: 5px; background: var(--panel-2); color: var(--subtext); font: 500 11px/1 var(--ui-font); white-space: nowrap; cursor: pointer; }
.ref > span:not(.ahead) { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ref .ic { width: 12px; height: 12px; }
.ref.head { border-color: var(--accent-wash-border); background: var(--accent-wash); color: var(--accent); font-weight: 600; }
.ref.remote { border-style: dashed; }
.ref .ahead { display: inline-flex; align-items: center; gap: 1px; padding-left: 4px; margin-left: 1px; border-left: 1px solid var(--accent-wash-border); font: 600 10.5px/1 var(--mono-font); }
.ref .ahead .ic { width: 10px; height: 10px; }
.ref .cloud { color: var(--subtle); }
.ref.head .cloud { color: inherit; opacity: 0.8; }
.ref.dragging { opacity: 0.5; }

/* Tri-state checkbox. */
.cb { display: inline-grid; place-items: center; flex: none; width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid var(--subtle); background: transparent; color: var(--accent-fg); transition: background 0.15s, border-color 0.15s; }
.cb .ic { width: 12px; height: 12px; }
.cb.on, .cb.some { border-color: var(--accent); background: var(--accent); }
.cb.some::before { content: ""; width: 8px; height: 2px; border-radius: 1px; background: var(--accent-fg); }
.cb-cell { display: grid; place-items: center; flex: none; width: 30px; align-self: stretch; }
.cb-cell:hover .cb:not(.on):not(.some) { border-color: var(--subtext); }
.cb-cell:disabled { opacity: 0.45; }

/* One dot per block, filled when it is staged. */
.dots { display: inline-flex; align-items: center; gap: 3px; }
.dots .dot { width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--subtle) 85%, transparent); }
.dots .dot.on { border-color: var(--accent); background: var(--accent); }
.dots .more { font: 500 10px/1 var(--mono-font); color: var(--subtle); }

/* One segment per block, lit when staged. */
.segs { display: inline-flex; gap: 2px; flex-wrap: wrap; }
.segs i { width: 10px; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--text) 13%, transparent); }
.segs i.on { background: var(--accent); }

.tool { display: inline-grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 6px; color: var(--subtle); }
.tool:hover { background: var(--surface-hover); color: var(--text); }
.tool[aria-pressed="true"], .tool[aria-expanded="true"] { color: var(--accent); background: var(--accent-wash); }
.tool .n { margin-left: 3px; font: 600 10.5px/1 var(--mono-font); }
.tool .n:empty { display: none; }
.tool.wide { width: auto; padding: 0 7px; display: inline-flex; align-items: center; gap: 4px; }
.linkbtn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; border-radius: 5px; color: var(--subtext); font: 500 11.5px var(--ui-font); white-space: nowrap; }
.linkbtn:hover { color: var(--text); background: var(--surface-hover); }

/* The app's Button, in the four variants the panel uses. */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none; height: 32px; padding: 0 10px; border: 1px solid transparent; border-radius: 6px; font-size: 13px; font-weight: 500; white-space: nowrap; transition: background 0.15s, opacity 0.15s; }
.btn:disabled { opacity: 0.5; pointer-events: none; }
.btn.xs { height: 24px; gap: 4px; padding: 0 6px; font-size: 12px; }
.btn.icon { width: 32px; padding: 0; }
.btn.primary { background: var(--accent); color: var(--accent-fg); }
.btn.primary:hover { background: color-mix(in srgb, var(--accent) 90%, var(--text)); }
.btn.outline { border-color: var(--border2); background: var(--bg); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04); }
.btn.outline:hover { background: var(--surface-hover); }
.btn.ghost { color: var(--subtext); }
.btn.ghost:hover { background: var(--surface-hover); color: var(--text); }
.btn.danger { background: var(--red); color: #fff; }
.btn.danger:hover { background: color-mix(in srgb, var(--red) 88%, var(--text)); }

/* ---------- toolbar ---------- */
#toolbar { position: relative; z-index: 6; flex: none; display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 8px 0 10px; border-bottom: 1px solid var(--border); background: var(--panel); }
#toolbar .sep { width: 1px; height: 18px; margin: 0 4px; background: var(--border); flex: none; }
.gg-scope { display: inline-flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; max-width: 240px; height: 28px; padding: 0 8px; border: 1px solid var(--border2); border-radius: 7px; background: var(--bg); color: var(--text); font-size: 12.5px; font-weight: 500; white-space: nowrap; }
.gg-scope:hover { border-color: color-mix(in srgb, var(--text) 25%, transparent); }
.gg-scope .ic { color: var(--subtle); }
.gg-scope .scope-lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
#find-bar { position: relative; display: flex; flex: 0 1 300px; min-width: 120px; }
.gg-find { position: relative; display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: 28px; padding: 0 4px 0 8px; border: 1px solid var(--border2); border-radius: 7px; background: var(--bg); color: var(--subtle); }
.gg-find:focus-within { border-color: var(--accent); }
.gg-find input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: none; color: var(--text); font-size: 12.5px; padding: 0; }
.gg-find input:focus-visible { outline: none; }
.gg-find input::placeholder { color: var(--subtle); }
.gg-find .count { font: 500 11px var(--mono-font); color: var(--subtle); white-space: nowrap; }
.gg-find .count:empty { display: none; }
.gg-find .count .short { display: none; }
.gg-find .step, .gg-find .clear { display: inline-grid; place-items: center; flex: none; width: 20px; height: 20px; border-radius: 5px; color: var(--subtle); }
.gg-find .step:hover, .gg-find .clear:hover { color: var(--text); background: var(--surface-hover); }
.gg-find input:placeholder-shown ~ .clear, .gg-find input:placeholder-shown ~ .step { display: none; }
.gg-find .mode { display: inline-flex; align-items: center; gap: 2px; flex: none; height: 20px; padding: 0 4px 0 6px; border-radius: 5px; background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--subtext); font: 500 11px var(--ui-font); white-space: nowrap; }
.sync { display: inline-flex; align-items: center; flex: none; height: 28px; border: 1px solid var(--border2); border-radius: 7px; background: var(--bg); overflow: hidden; }
.sync button { display: inline-flex; align-items: center; gap: 5px; height: 100%; padding: 0 9px; color: var(--subtext); font: 500 12px var(--ui-font); white-space: nowrap; }
.sync button + button { border-left: 1px solid var(--border); }
.sync button:hover { background: var(--surface-hover); color: var(--text); }
.sync button:disabled { opacity: 0.45; }
.sync button:disabled:hover { background: none; color: var(--subtext); }
.sync .num { display: inline-grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 999px; font: 600 10.5px/1 var(--mono-font); background: color-mix(in srgb, var(--text) 9%, transparent); color: var(--subtext); }
.sync .num:empty { display: none; }
.sync .num.hot { background: var(--accent); color: var(--accent-fg); }
.sc-sync { display: inline-flex; align-items: center; gap: 6px; flex: none; height: 28px; padding: 0 8px; border: 1px solid var(--border2); border-radius: 7px; background: var(--bg); color: var(--subtext); font: 500 12px var(--ui-font); white-space: nowrap; }
.sc-sync:hover { color: var(--text); border-color: color-mix(in srgb, var(--text) 25%, transparent); }
.sc-sync .ab { display: inline-flex; gap: 6px; font: 600 11px var(--mono-font); }
.sc-sync .ab > span { display: inline-flex; align-items: center; gap: 1px; }
.sc-sync .ab .up { color: var(--accent); }
.sc-sync.primary { border-color: transparent; background: var(--accent); color: var(--accent-fg); }
.sc-sync.primary .ab .up { color: inherit; }
.sc-sync:disabled { opacity: 0.45; }
#btn-sync-m, #btn-find { display: none; }
[aria-busy="true"] { pointer-events: none; }
[aria-busy="true"] > .ic:first-child { animation: gg-spin 0.8s linear infinite; }

/* ---------- stopped merge / rebase ---------- */
.op-banner { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 8px 10px 8px 12px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--yellow) 10%, var(--bg)); font-size: 12.5px; color: var(--subtext); }
.op-banner > .ic { color: var(--yellow); }
.op-banner .txt { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; }
.op-banner .txt b { color: var(--text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-banner .acts { display: flex; gap: 6px; }

/* ---------- the list and its inspector ---------- */
#gg-main { position: relative; flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) var(--gg-inspector-w); }
.insp-closed #gg-main { grid-template-columns: minmax(0, 1fr); }
.insp-closed #detail-panel { display: none; }
#graph-area { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
#graph-container { position: relative; flex: 1; min-height: 0; overflow: auto; container: graphlist / inline-size; }
#commit-list-wrapper { position: relative; }

/* Rows: graph, message (and refs), changes, author, date, hash. */
.commit-row { position: relative; display: flex; align-items: center; gap: 10px; height: var(--gg-row-h); padding-right: 12px; font-size: 13px; cursor: pointer; }
.commit-row > div { min-width: 0; }
.col-graph { position: relative; flex: none; width: var(--graph-col-w, 120px); }
.commit-row:not(.header-row) .col-graph { align-self: stretch; touch-action: pan-y; }
.col-message { flex: 1 1 0; min-width: ${messageMinW}px; display: flex; align-items: center; gap: 8px; overflow: hidden; }
.col-changes { flex: none; width: 84px; white-space: nowrap; }
.col-author { flex: none; width: 120px; display: flex; align-items: center; gap: 7px; overflow: hidden; color: var(--subtext); font-size: 12px; }
.col-author > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-date { flex: none; width: 44px; color: var(--subtle); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.date-abs .col-date { width: 92px; }
.date-iso .col-date { width: 116px; }
.col-hash { flex: none; width: 60px; color: var(--subtle); font: 11px var(--mono-font); white-space: nowrap; overflow: hidden; }
.cols-no-changes .col-changes { display: none; }
.cols-no-author .col-author { display: none; }
.cols-no-date .col-date { display: none; }
.cols-no-hash .col-hash { display: none; }

.header-row { position: sticky; top: 0; z-index: 4; height: 28px; border-bottom: 1px solid var(--border); background: var(--bg); font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--subtle); cursor: default; }
.header-row > div { overflow: hidden; white-space: nowrap; }
.header-row .col-graph { padding-left: 12px; overflow: visible; }
.graph-resize-handle { position: absolute; top: 4px; bottom: 4px; right: -6px; width: 9px; cursor: col-resize; z-index: 2; touch-action: none; }
.graph-resize-handle::after { content: ""; position: absolute; top: 3px; bottom: 3px; left: 4px; width: 1px; background: var(--border2); opacity: 0; transition: opacity 0.15s; }
.header-row:hover .graph-resize-handle::after, .graph-resize-handle.dragging::after { opacity: 1; }

/* The pills come first and keep their whole names; the subject takes what is left and is the one cut
   short, down to its own 60px. No cap on a pill: the name's end is usually the part that differs. */
.msg-subject { flex: 1 1 0; min-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.commit-row.merge .msg-subject { color: var(--subtext); }
.commit-row.stash .msg-subject { color: var(--subtext); font-style: italic; }
.refs { display: flex; gap: 4px; flex: 0 1 auto; min-width: 0; }
.refs .ref { flex: 0 1 auto; min-width: 0; max-width: none; }
.refs .ref > .ic, .refs .ref > .ahead { flex: none; }
.msg-meta { display: none; }
.commit-row mark { background: color-mix(in srgb, var(--yellow) 28%, transparent); color: inherit; border-radius: 2px; }
.commit-row.wip .msg-subject { flex: none; min-width: 0; font-weight: 500; }
.wip-meta { display: inline-flex; align-items: center; gap: 8px; flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--subtle); font-size: 12px; white-space: nowrap; }
.wip-meta > span:last-child { overflow: hidden; text-overflow: ellipsis; }
.wip-meta .segs { flex-wrap: nowrap; }
.wip-meta .segs i { width: 7px; height: 5px; }
.wip-meta .bad { color: var(--red); }
.wip-files { display: none; }
.quick { display: inline-flex; align-items: center; gap: 4px; flex: none; height: 22px; padding: 0 7px; border: 1px solid var(--accent-wash-border); border-radius: 6px; background: var(--accent-wash); color: var(--accent); font: 500 11.5px var(--ui-font); white-space: nowrap; }

.commit-row:hover { background: var(--surface-hover); }
.commit-row.dim .col-message, .commit-row.dim .col-changes, .commit-row.dim .col-author, .commit-row.dim .col-date, .commit-row.dim .col-hash { opacity: 0.5; }
.commit-row.search-match { background: color-mix(in srgb, var(--yellow) 7%, transparent); }
.commit-row.selected { background: var(--accent-wash); box-shadow: inset 2px 0 0 var(--accent); }
.commit-row.drop-target { box-shadow: inset 0 0 0 2px var(--accent); }
.header-row:hover { background: var(--bg); }

/* The graph: one SVG for every row, laid over the graph column and clipped to it. */
#graph-clip { position: absolute; top: 0; left: 0; width: var(--graph-col-w, 120px); height: 100%; overflow: hidden; z-index: 1; pointer-events: none; }
#graph-svg-container { position: absolute; top: 0; left: 0; transform: translateX(calc(-1 * var(--graph-pan-x, 0px))); }
#graph-svg-container svg { display: block; overflow: visible; }
#graph-svg-container path.line { fill: none; stroke-width: 2; stroke-linecap: round; }
#graph-svg-container path.dash { stroke-dasharray: 3 3; }
.graph-can-pan .commit-row:not(.header-row) .col-graph { cursor: grab; }
.graph-panning, .graph-panning * { cursor: grabbing !important; user-select: none; }
#graph-pan-bar { position: absolute; top: 31px; left: 0; width: var(--graph-col-w, 120px); height: 4px; pointer-events: none; opacity: 0; transition: opacity 0.2s; z-index: 5; }
#graph-pan-bar.visible { opacity: 1; }
#graph-pan-thumb { position: absolute; top: 0; bottom: 0; border-radius: 2px; background: color-mix(in srgb, var(--text) 32%, transparent); }

/* One tick per interesting row, beside the scroller rather than in it. */
#scroll-markers { position: absolute; top: 28px; right: 0; bottom: 0; width: 6px; pointer-events: none; z-index: 5; }
.scroll-marker { position: absolute; right: 0; width: 6px; height: 2px; border-radius: 1px; }
.sm-search { background: var(--yellow); }
.sm-head { background: var(--accent); }
.sm-selected { background: var(--text); }

.loading { padding: 10px 14px; color: var(--subtle); font-size: 12px; }
.list-empty { padding: 40px 20px; text-align: center; color: var(--subtle); font-size: 12.5px; }

/* History search results, over the list. */
.search-results { position: absolute; top: 8px; left: 50%; z-index: 20; width: min(560px, calc(100% - 24px)); max-height: 60%; overflow-y: auto; transform: translateX(-50%); padding: 4px; border: 1px solid var(--border2); border-radius: 10px; background: var(--panel-2); box-shadow: var(--shadow-panel); }
.sr-head { display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: 11.5px; color: var(--subtle); }
.sr-item { display: flex; flex-direction: column; gap: 3px; width: 100%; padding: 6px 8px; border-radius: 6px; text-align: left; }
.sr-item:hover { background: var(--surface-hover); }
.sr-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-meta { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--subtle); white-space: nowrap; overflow: hidden; }
.sr-hash { font-family: var(--mono-font); }

/* ---------- inspector ---------- */
.detail-panel { position: relative; min-width: 0; min-height: 0; overflow-y: auto; border-left: 1px solid var(--border); background: var(--panel); }
.gi-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 100%; padding: 24px; color: var(--subtle); font-size: 12.5px; text-align: center; }
.gi-head { padding: 12px 14px 12px 16px; border-bottom: 1px solid var(--border); }
.gi-top { display: flex; align-items: center; gap: 9px; min-height: 28px; }
.gi-who { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.gi-who b { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gi-who small { font-size: 11.5px; color: var(--subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gi-subj { margin-top: 12px; font-size: 15px; font-weight: 600; line-height: 1.35; letter-spacing: -0.005em; overflow-wrap: anywhere; }
.gi-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 10px; font-size: 12px; color: var(--subtle); }
.hash { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--subtext); font: 500 11.5px var(--mono-font); }
.hash:hover { color: var(--text); border-color: var(--border2); }
.hash .ic { width: 12px; height: 12px; color: var(--subtle); }
.hash.copied, .hash.copied .ic { color: var(--green); }
.hash.copy-failed, .hash.copy-failed .ic { color: var(--red); }
.gi-refs { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
.gi-acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.gi-acts > .btn { font-size: 13px; padding: 0 9px; gap: 5px; }
.gi-acts .more-act { display: none; }
.gi-body { padding: 14px 16px; border-bottom: 1px solid var(--border); font-size: 13px; line-height: 1.65; color: var(--subtext); overflow-wrap: anywhere; }
.msg-p { max-width: 68ch; }
.msg-p + .msg-p, .msg-pre + .msg-p, .msg-p + .msg-pre, .msg-pre + .msg-pre { margin-top: 10px; }
.msg-pre { font-family: var(--mono-font); font-size: 12px; line-height: 1.55; white-space: pre-wrap; }
.commit-link { color: var(--accent); text-decoration: none; }
a.commit-link:hover { text-decoration: underline; }
.gi-sec { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px 0 16px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--subtle); }
.gi-sec .n, .sc-lh .n, .sc-group .n { padding: 1px 6px; border-radius: 999px; font: 500 10.5px/14px var(--mono-font); letter-spacing: 0; color: var(--subtext); background: color-mix(in srgb, var(--text) 8%, transparent); }
.gi-sec .cnt { letter-spacing: 0; }
.gi-note { padding: 4px 16px 10px; font-size: 12px; color: var(--subtle); }
.gi-file { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto 18px; align-items: center; gap: 9px; width: 100%; min-height: 38px; padding: 3px 12px 3px 16px; color: var(--text); text-align: left; }
.gi-file:hover { background: var(--surface-hover); }
.gi-file .nm, .sc-row .nm { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.gi-file .nm b, .sc-row .nm b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.gi-file .nm small, .sc-row .nm small { font-size: 11px; color: var(--subtle); }
.gi-file .open { display: none; color: var(--subtle); }
@media (hover: hover) {
  .gi-file:hover .open { display: inline-block; }
  .gi-file:hover .cnt { display: none; }
}
.gi-det { padding: 4px 16px 16px; }
.gi-det summary { display: flex; align-items: center; gap: 6px; height: 34px; list-style: none; cursor: pointer; font-size: 12px; font-weight: 500; color: var(--subtext); }
.gi-det summary::-webkit-details-marker { display: none; }
.gi-det summary .ic { transition: transform 0.15s; color: var(--subtle); }
.gi-det[open] summary .ic { transform: rotate(90deg); }
.detail-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin-top: 4px; font-size: 12px; }
.meta-label { color: var(--subtle); }
.meta-cells { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.meta-value { min-width: 0; color: var(--subtext); overflow-wrap: anywhere; cursor: pointer; border-radius: 4px; }
.meta-value:hover { color: var(--text); }
.meta-value.copied { color: var(--green); }
.meta-value.copy-failed { color: var(--red); }
.meta-value.mono { font: 11.5px var(--mono-font); }
.hash-lead { color: var(--text); }
.meta-name { color: var(--text); margin-right: 6px; }
.meta-email { color: var(--subtle); }
.meta-when { color: var(--subtext); }
.progress { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 12px; font-size: 12.5px; color: var(--subtext); }
.progress b { color: var(--text); font-weight: 600; }
.progress .linkbtn { margin-left: -6px; }

/* Uncommitted changes: the same composer and rows as Source Control. */
.cmp { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px 12px 16px; }
.cmp textarea { display: block; width: 100%; min-height: 58px; max-height: 140px; padding: 8px 10px; border: 1px solid var(--border2); border-radius: 10px; background: var(--bg); color: var(--text); font-size: 13px; line-height: 1.45; resize: none; outline: none; }
.cmp textarea::placeholder { color: var(--subtle); }
.cmp .row { display: flex; align-items: center; gap: 8px; }
.cmp .hint { font-size: 11.5px; color: var(--subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.split { display: flex; flex: 1; min-width: 0; height: 32px; }
.split > .btn { height: 100%; }
.split > .btn:first-child { flex: 1; min-width: 0; border-top-right-radius: 0; border-bottom-right-radius: 0; }
.split > .btn:first-child span { overflow: hidden; text-overflow: ellipsis; }
.split > .btn:last-child { width: 32px; padding: 0; border-top-left-radius: 0; border-bottom-left-radius: 0; border-left: 1px solid rgba(255, 255, 255, 0.22); }
.sc-lh { display: flex; align-items: center; gap: 6px; height: 34px; padding-left: 16px; border-top: 1px solid var(--border); }
.sc-lh .lbl, .sc-group { font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--subtle); }
.sc-group { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 16px; }
.sc-group.err { color: var(--red); }
.sc-row { position: relative; display: flex; align-items: stretch; min-height: 40px; }
.sc-row:hover { background: var(--surface-hover); }
.sc-row .main { flex: 1; min-width: 0; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto 18px; align-items: center; gap: 8px; padding: 3px 0 3px 16px; color: var(--text); text-align: left; }
.sc-row.del .nm b { text-decoration: line-through; color: var(--subtext); }
.sc-row .rt { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.sc-row .resolve { font-size: 11.5px; font-weight: 500; color: var(--accent); }
.sc-row .acts { position: absolute; right: 30px; top: 0; bottom: 0; display: flex; align-items: center; gap: 2px; padding: 0 2px 0 22px; background: linear-gradient(to left, var(--panel) 72%, transparent); transition: opacity 0.15s; }
@media (hover: hover) {
  .sc-row .acts { opacity: 0; }
  .sc-row:hover .acts, .sc-row:focus-within .acts { opacity: 1; }
}
.sc-row .acts button { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--subtle); }
.sc-row .acts button:hover { color: var(--text); background: color-mix(in srgb, var(--text) 8%, transparent); }
.sc-row .acts button.danger:hover { color: var(--red); }
.sc-row .acts button:disabled { opacity: 0.4; }

/* ---------- status bar ---------- */
#status-bar { flex: none; display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 14px; border-top: 1px solid var(--border); background: var(--bg); color: var(--subtle); font-size: 12px; white-space: nowrap; }
#status-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* ---------- menus, sheets, toasts, dialogs ---------- */
.menu { position: fixed; z-index: 50; min-width: 210px; max-width: 340px; max-height: calc(100vh - 16px); overflow-y: auto; padding: 4px; border: 1px solid var(--border2); border-radius: 8px; background: var(--panel-2); box-shadow: var(--shadow-panel); font-size: 13px; color: var(--text); }
.menu .mi { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 30px; padding: 5px 8px; border-radius: 6px; text-align: left; white-space: nowrap; }
.menu .mi:hover, .menu .mi:focus-visible { background: color-mix(in srgb, var(--text) 6%, transparent); outline: none; }
/* The menu takes focus only so the arrow keys reach it; the item under them is what shows it. */
.menu:focus-visible { outline: none; }
.menu .mi > .ic { color: var(--subtext); }
.menu .mi .tick { color: var(--accent); }
.menu .mi .blank { display: inline-block; flex: none; width: 16px; }
.menu .mi > span:not(.kb):not(.sub) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.menu .mi.danger, .menu .mi.danger > .ic { color: var(--red); }
.menu .mi:disabled { opacity: 0.45; }
.menu .mi:disabled:hover { background: none; }
.menu .mi .kb { margin-left: auto; padding-left: 16px; font: 500 11px var(--mono-font); color: var(--subtle); }
.menu .mi .sub { margin-left: auto; padding-left: 12px; font-size: 11.5px; color: var(--subtle); }
.menu .sep { height: 1px; margin: 4px -4px; background: var(--border); }
.menu .lbl { padding: 6px 8px 4px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--subtle); }
.menu .row2 { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.menu .row2 > span { overflow: hidden; text-overflow: ellipsis; }
.menu .row2 small { font-size: 11.5px; color: var(--subtle); overflow: hidden; text-overflow: ellipsis; }
.menu .empty { padding: 6px 8px; color: var(--subtle); font-size: 12px; }
.menu-filter { display: flex; align-items: center; gap: 6px; margin: 2px 2px 4px; padding: 0 8px; height: 30px; border: 1px solid var(--border2); border-radius: 6px; background: var(--bg); color: var(--subtle); }
.menu-filter:focus-within { border-color: var(--accent); }
.menu-filter input { flex: 1; min-width: 0; height: 100%; border: 0; padding: 0; background: none; outline: none; }
.menu .grab, .dialog .grab, .detail-panel .grab { display: none; }
#menu-scrim, #sheet-scrim { position: fixed; inset: 0; z-index: 29; background: rgba(0, 0, 0, 0.4); }
#menu-scrim { z-index: 49; }

#toast-host { position: fixed; left: 50%; bottom: 52px; z-index: 55; display: flex; flex-direction: column; align-items: center; gap: 8px; width: max-content; max-width: calc(100% - 24px); transform: translateX(-50%); pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 12px; max-width: 100%; padding: 7px 7px 7px 14px; border: 1px solid var(--border2); border-radius: 10px; background: var(--panel-2); box-shadow: var(--shadow-float); font-size: 12.5px; }
.toast > .ic { color: var(--accent); }
.toast-error > .ic { color: var(--red); }
.toast-warning > .ic { color: var(--yellow); }
.toast-text { display: flex; flex-direction: column; min-width: 0; }
.toast-text > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast-error .toast-text > span { white-space: normal; overflow-wrap: anywhere; }
.toast-text small { font-size: 11.5px; color: var(--subtle); }
.toast .tool { width: 24px; height: 24px; }

.dialog-overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, 0.4); }
.dialog { display: flex; flex-direction: column; gap: 10px; width: min(440px, 100%); max-height: calc(100% - 32px); overflow-y: auto; padding: 16px; border: 1px solid var(--border2); border-radius: 12px; background: var(--panel-2); box-shadow: var(--shadow-panel); }
.dialog h3 { display: flex; align-items: center; gap: 8px; font-size: 14.5px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.dialog h3 .ic { color: var(--red); }
.dialog p { font-size: 12.5px; line-height: 1.5; color: var(--subtext); overflow-wrap: anywhere; }
.dialog input[type=text], .dialog select { width: 100%; height: 32px; font-size: 13px; }
.dialog .check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--subtext); }
.dialog .radios { display: flex; gap: 14px; font-size: 12.5px; color: var(--subtext); }
.dialog .radios label { display: flex; align-items: center; gap: 6px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }

/* ---------- settings ---------- */
#settings-panel { position: fixed; top: 0; right: 0; bottom: 0; z-index: 40; display: flex; flex-direction: column; width: min(420px, 100%); border-left: 1px solid var(--border2); background: var(--panel-2); box-shadow: var(--shadow-panel); transform: translateX(105%); visibility: hidden; transition: transform 0.2s ease, visibility 0s linear 0.2s; }
/* Off-screen alone is still reachable by Tab; visibility follows the slide out, so it stays animated. */
#settings-panel.open { transform: none; visibility: visible; transition: transform 0.2s ease; }
.settings-header { flex: none; display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--border); }
.settings-header h3 { font-size: 13px; font-weight: 600; }
.settings-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0 16px; }
.settings-section { padding: 4px 16px; border-bottom: 1px solid var(--border); }
.settings-section summary { display: flex; align-items: center; height: 36px; list-style: none; cursor: pointer; font-size: 10.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--subtle); }
.settings-section summary::-webkit-details-marker { display: none; }
.settings-section > p { font-size: 11.5px; color: var(--subtle); margin-bottom: 6px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; font-size: 12.5px; }
.setting-row label { color: var(--subtext); }
.setting-row input[type=text], .setting-row input[type=number], .setting-row select { width: 180px; }
.setting-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent); }
.remote-item { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.remote-name { font-weight: 600; }
.remote-url { color: var(--subtle); font-family: var(--mono-font); font-size: 11px; overflow-wrap: anywhere; }
.remote-actions { display: flex; gap: 6px; }
.add-remote-form { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0; }
.add-remote-form input { flex: 1 1 140px; }
.issue-rule-row { display: flex; gap: 6px; margin-bottom: 6px; }
.issue-rule-row input { flex: 1; min-width: 0; }
.rule-error { border-color: var(--red) !important; }
.settings-note { font-size: 11px; color: var(--subtle); margin: 2px 0 4px; }

/* ---------- touch ---------- */
@media (pointer: coarse) {
  :root { --gg-row-h: 40px; }
  .tool { width: 36px; height: 36px; }
  .gg-scope, .gg-find, .sync, .sc-sync { height: 36px; }
  .gg-find .step, .gg-find .clear { width: 28px; height: 28px; }
  .menu .mi { min-height: 40px; }
  .sc-row { min-height: 48px; }
  .sc-row .acts button { width: 32px; height: 32px; }
  .gi-file { min-height: 44px; }
  .linkbtn { height: 32px; }
  .op-banner .btn { height: 36px; }
}

/* ---------- toolbar tiers ---------- */
@media (max-width: 880px) {
  .sync .lbl { display: none; }
}
@media (max-width: 700px) {
  #toolbar .opt, #toolbar .sep { display: none; }
}
@media (max-width: 470px) {
  .gg-scope .scope-lbl, .gg-find .mode { display: none; }
}
@media (max-width: 420px) {
  #find-bar, .gg-find { min-width: 0; }
  #find-bar { flex: 1 1 0; }
  .gg-find .count { display: none; }
}

/* ---------- column tiers: the list's own width, not the window's ---------- */
@container graphlist (max-width: 900px) {
  .col-hash { display: none; }
}
@container graphlist (max-width: 760px) {
  .col-author { width: 18px; }
  .commit-row:not(.header-row) .col-author > span:last-child { display: none; }
  .header-row .col-author { visibility: hidden; }
}
@container graphlist (max-width: 600px) {
  .col-changes { display: none; }
}
/* No tier below this: the inspector is a column only above 900px, so a list
   narrower than 521px is the phone layout, and the phone block owns its rows. */

/* ---------- the inspector over the list: a window too narrow for both ---------- */
@media (max-width: 900px) {
  #gg-main { grid-template-columns: minmax(0, 1fr); }
  #detail-panel { position: absolute; top: 0; right: 0; bottom: 0; z-index: 8; width: min(var(--gg-inspector-w), 92%); box-shadow: var(--shadow-panel); }
}

/* ---------- phone ---------- */
@media (max-width: 640px) {
  :root { --gg-row-h: 56px; }
  .col-message { min-width: 0; }
  #toolbar { height: 52px; gap: 6px; padding: 0 6px 0 10px; }
  #toolbar .opt, #toolbar .sep, #sync, #btn-inspector { display: none; }
  #find-bar { display: none; }
  #btn-sync-m, #btn-find { display: inline-flex; }
  #btn-find { display: inline-grid; }
  .tool { width: 44px; height: 44px; border-radius: 10px; }
  .gg-scope, .sc-sync { height: 36px; }
  .gg-scope { font-size: 13px; }
  .gg-scope .scope-lbl { display: inline; }
  /* Drawn at the design's 36px and 22px; an invisible edge takes each tap target to 44px
     (insets count from inside the 1px border). The meta line gets the room for it. */
  .gg-scope, .sc-sync, .gi-meta .hash { position: relative; }
  .gg-scope::after, .sc-sync::after { content: ""; position: absolute; inset: -5px 0; }
  .gi-meta .hash::after { content: ""; position: absolute; inset: -12px -2px; }
  .gi-meta { row-gap: 24px; margin-top: 14px; }
  #toolbar.find-open > :not(#find-bar) { display: none; }
  #toolbar.find-open #find-bar { display: flex; flex: 1 1 auto; }
  /* 44 inside the border. The box is a label, so a tap anywhere in it reaches the input. */
  #toolbar.find-open .gg-find { height: 46px; }
  #toolbar.find-open .gg-find .mode { display: inline-flex; position: relative; }
  #toolbar.find-open .gg-find .mode::after { content: ""; position: absolute; inset: -12px 0; }
  #toolbar.find-open .gg-find .clear { display: inline-grid; }
  #toolbar.find-open .gg-find .clear, #toolbar.find-open .gg-find .step { width: 44px; height: 44px; }
  /* The box has the toolbar to itself here, so the count the 420px tier drops comes back:
     without it a search that matches nothing is a list gone dim for no stated reason. */
  #toolbar.find-open .gg-find .count:not(:empty) { display: inline; }
  #toolbar.find-open .gg-find .count .short { display: inline; }
  #toolbar.find-open .gg-find .count .long { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .header-row { display: none; }
  .col-changes, .col-author, .col-date, .col-hash { display: none; }
  .commit-row { padding-right: 12px; }
  .col-message { flex-wrap: wrap; align-content: center; row-gap: 3px; column-gap: 6px; }
  /* The subject keeps the first line to itself; the branch starts the second. */
  .col-message .msg-subject { flex: 1 1 100%; order: -1; }
  .col-message .refs .ref:not(:first-child) { display: none; }
  .col-message .refs .ref { max-width: 180px; }
  .msg-meta { display: block; flex: 1 1 0; min-width: 40px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--subtle); }
  /* Two lines like every other row: the subject, then "N of M blocks staged · K files". */
  .commit-row.wip .msg-subject { flex: 1 1 100%; }
  .commit-row.wip .wip-meta { flex: 1 1 0; font-size: 11.5px; }
  .commit-row.wip .wip-meta .segs { display: none; }
  .wip-files { display: inline; }
  .commit-row.wip .quick { display: none; }
  /* With the sheet shut the selection mark goes, except on the match find stepped to. An older selection
     that merely matches the query stays unmarked, or it reads as the current match before any step. */
  .insp-closed .commit-row.selected:not(.find-current) { background: none; box-shadow: none; }
  /* Unmarked, such a row is still a match like any other. */
  .insp-closed .commit-row.selected.search-match:not(.find-current) { background: color-mix(in srgb, var(--yellow) 7%, transparent); }
  #status-bar { height: 44px; }
  .op-banner .acts { flex: 1 1 100%; }
  .op-banner .acts .btn { flex: 1 1 0; height: 44px; font-size: 13px; }
  #detail-panel { position: fixed; top: auto; left: 0; right: 0; bottom: 0; z-index: 30; width: auto; max-height: 78%; border-left: 0; border-top: 1px solid var(--border2); border-radius: 16px 16px 0 0; background: var(--panel-2); padding-bottom: 22px; box-shadow: var(--shadow-panel); }
  .detail-panel .grab { display: flex; justify-content: center; padding: 12px 0 4px; }
  .detail-panel .grab::before, .menu .grab::before, .dialog .grab::before { content: ""; width: 40px; height: 4px; border-radius: 4px; background: var(--border2); }
  .detail-panel .gi-head { padding-top: 4px; }
  .gi-acts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .gi-acts > .btn { flex-direction: column; gap: 4px; height: 60px; padding: 0 4px; border-radius: 12px; font-size: 12px; white-space: normal; text-align: center; line-height: 1.2; }
  .gi-acts .more-act { display: inline-flex; }
  .gi-top .more-top { display: none; }
  .gi-file { min-height: 52px; }
  .sc-row { min-height: 56px; }
  .cb-cell { width: 48px; }
  /* As in Source Control: a phone reaches Open file and Discard by a long press on the row. */
  .sc-row .acts { display: none; }
  .linkbtn { height: 44px; }
  /* 44 inside the 1px top border, which is what the select-all box stretches to. */
  .sc-lh { height: 45px; }
  .cmp .split { height: 44px; }
  .cmp .split > .btn { font-size: 15px; }
  .cmp .split > .btn:last-child { width: 44px; }
  .menu.as-sheet { left: 0 !important; right: 0; top: auto !important; bottom: 0; width: auto; min-width: 0; max-width: none; max-height: 78%; padding: 0 8px 22px; border-radius: 16px 16px 0 0; }
  .menu.as-sheet .grab { display: flex; justify-content: center; padding: 12px 0 6px; }
  .menu.as-sheet .mi { min-height: 48px; font-size: 14px; }
  .dialog-overlay { place-items: end stretch; padding: 0; }
  .dialog { width: 100%; max-height: 85%; border-radius: 16px 16px 0 0; padding: 4px 16px 22px; }
  .dialog .grab { display: flex; justify-content: center; padding: 8px 0 2px; }
  .dialog-actions { flex-direction: column-reverse; }
  .dialog-actions .btn { width: 100%; height: 44px; }
  #toast-host { bottom: 16px; }
  #settings-panel { width: 100%; }
}
`;
}
