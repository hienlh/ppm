/**
 * Generate the complete webview HTML for the git graph panel.
 * All JS + CSS is inlined since webview runs in an iframe sandbox.
 */
import { AVATAR_JS, FONT_TOKENS } from "./webview-shell.ts";
import { COMMIT_MESSAGE_JS } from "./commit-message-html.ts";

export function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${getStyles()}
</style>
</head>
<body>
  <div id="app">
    <header id="toolbar">
      <div class="toolbar-left">
        <div id="branch-selector" class="branch-dropdown">
          <button id="branch-trigger" class="branch-trigger">All Branches</button>
          <div id="branch-dropdown-menu" class="branch-dropdown-menu hidden">
            <input id="branch-filter" type="text" placeholder="Filter branches..." class="branch-filter-input" />
            <div id="branch-list" class="branch-list"></div>
          </div>
        </div>
        <button id="btn-refresh" title="Refresh"></button>
        <button id="btn-fetch" title="Fetch from remotes"></button>
      </div>
      <div class="toolbar-right">
        <div class="stash-dropdown">
          <button id="btn-stash" title="Stashes"></button>
          <div id="stash-popover" class="stash-popover hidden">
            <div class="stash-popover-header"><span>Stashes</span></div>
            <div id="stash-list" class="stash-list"></div>
            <div class="stash-popover-footer">
              <button id="stash-save" class="btn-sm">+ Stash Changes</button>
            </div>
          </div>
        </div>
        <div class="worktree-dropdown">
          <button id="btn-worktree" title="Worktrees"></button>
          <div id="worktree-popover" class="worktree-popover hidden">
            <div class="worktree-popover-header">
              <span>Worktrees</span>
            </div>
            <div id="worktree-list" class="worktree-list"></div>
            <div class="worktree-popover-footer">
              <button id="wt-add" class="btn-sm">+ Add Worktree</button>
              <button id="wt-prune" class="btn-sm secondary" title="Remove stale worktree entries">Prune</button>
            </div>
          </div>
        </div>
        <div class="submodule-dropdown hidden" id="submodule-wrap">
          <button id="btn-submodule" title="Submodules"></button>
          <div id="submodule-popover" class="worktree-popover hidden">
            <div class="worktree-popover-header"><span>Submodules</span></div>
            <div id="submodule-list" class="worktree-list"></div>
            <div class="worktree-popover-footer">
              <button id="sm-update-all" class="btn-sm">Update all</button>
            </div>
          </div>
        </div>
        <button id="btn-reflog" title="Reflog — undo a rebase, reset or deleted branch"></button>
        <button id="btn-find" title="Find (Ctrl+F)"></button>
        <button id="btn-settings" title="Settings"></button>
      </div>
    </header>
    <div id="find-bar" class="find-bar hidden">
      <input id="find-input" type="text" placeholder="Search commits..." />
      <select id="find-mode" title="Where to search">
        <option value="loaded">Loaded rows</option>
        <option value="message">Message (all history)</option>
        <option value="author">Author (all history)</option>
        <option value="content">Code change (all history)</option>
        <option value="file">Touched file (all history)</option>
      </select>
      <span id="find-count"></span>
      <button id="find-prev" title="Previous">&uarr;</button>
      <button id="find-next" title="Next">&darr;</button>
      <button id="find-close" title="Close">&times;</button>
    </div>
    <div id="search-results" class="search-results hidden"></div>
    <div id="graph-area">
    <div id="graph-container">
      <div id="graph-header" class="commit-row header-row">
        <div class="col-refs">Branch / Tag</div>
        <div class="col-graph">Graph<div class="graph-resize-handle" id="graph-resize-handle"></div></div>
        <div class="col-message">Message</div>
        <div class="col-changes">Changes</div>
        <div class="col-author">Author</div>
        <div class="col-date">Date</div>
        <div class="col-hash">Hash</div>
      </div>
      <div id="commit-list-wrapper">
        <div id="graph-svg-container"></div>
        <div id="commit-list"></div>
      </div>
      <div id="loading" class="loading hidden">Loading...</div>
    </div>
      <div id="scroll-markers" aria-hidden="true"></div>
    </div>
    <div id="detail-panel" class="detail-panel hidden"></div>
    <div id="settings-panel" class="settings-panel">
      <div class="settings-header">
        <h3>Git Graph Settings</h3>
        <button id="settings-close" title="Close">&times;</button>
      </div>
      <div class="settings-body">
        <details class="settings-section" open>
          <summary>General</summary>
          <div class="setting-row"><label>Max Commits</label><input type="number" id="s-maxCommits" min="10" max="10000" step="50"></div>
          <div class="setting-row"><label>Show Tags</label><input type="checkbox" id="s-showTags"></div>
          <div class="setting-row"><label>Show Stashes</label><input type="checkbox" id="s-showStashes"></div>
          <div class="setting-row"><label>Show Remote Branches</label><input type="checkbox" id="s-showRemoteBranches"></div>
          <div class="setting-row"><label>Graph Style</label><select id="s-graphStyle"><option value="rounded">Rounded</option><option value="angular">Angular</option></select></div>
          <div class="setting-row"><label>First Parent Only</label><input type="checkbox" id="s-firstParentOnly"></div>
          <div class="setting-row"><label>Date Format</label><select id="s-dateFormat"><option value="relative">Relative</option><option value="absolute">Absolute</option><option value="iso">ISO</option></select></div>
          <div class="setting-row"><label>Commit Ordering</label><select id="s-commitOrdering"><option value="topo">Topological</option><option value="date">Date</option><option value="author-date">Author Date</option></select></div>
          <div class="setting-row"><label>Auto Fetch Interval</label><select id="s-autoFetchInterval"><option value="0">Disabled</option><option value="10">10 seconds</option><option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option><option value="300">5 minutes</option></select></div>
        </details>
        <details class="settings-section" open>
          <summary>User Details</summary>
          <div class="setting-row"><label>Name</label><input type="text" id="s-userName" placeholder="user.name"></div>
          <div class="setting-row"><label>Email</label><input type="text" id="s-userEmail" placeholder="user.email"></div>
          <div class="setting-row" style="justify-content:flex-end"><button id="s-saveUser" class="btn-sm">Save User Details</button></div>
        </details>
        <details class="settings-section" open>
          <summary>Remotes</summary>
          <div id="s-remotes-list"></div>
          <div class="add-remote-form">
            <input type="text" id="s-newRemoteName" placeholder="Remote name">
            <input type="text" id="s-newRemoteUrl" placeholder="Remote URL">
            <button id="s-addRemote" class="btn-sm">Add Remote</button>
          </div>
        </details>
        <details class="settings-section">
          <summary>Issue Linking</summary>
          <p style="font-size:11px;color:var(--subtext);margin-bottom:6px">Turn issue references in commit messages into clickable links.</p>
          <div id="issue-rules-list"></div>
          <button id="add-issue-rule" class="btn-sm" style="margin-top:6px">+ Add Rule</button>
        </details>
        <details class="settings-section">
          <summary>Pull Request Creation</summary>
          <div class="setting-row"><label>Provider</label><select id="pr-provider"><option value="">Disabled</option><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="bitbucket">Bitbucket</option><option value="custom">Custom</option></select></div>
          <div id="pr-config" class="hidden">
            <div class="setting-row"><label>Owner</label><input type="text" id="pr-owner" placeholder="owner or org"></div>
            <div class="setting-row"><label>Repo</label><input type="text" id="pr-repo" placeholder="repository name"></div>
            <div class="setting-row"><label>Target Branch</label><input type="text" id="pr-target" placeholder="main"></div>
            <div class="setting-row"><label>URL Template</label><input type="text" id="pr-url-template" placeholder="https://..."></div>
            <p style="font-size:10px;color:var(--subtext);margin:2px 0 4px">Variables: \${owner}, \${repo}, \${sourceBranch}, \${targetBranch}</p>
            <div class="setting-row" style="justify-content:flex-end"><button id="pr-save" class="btn-sm">Save PR Config</button></div>
          </div>
        </details>
      </div>
    </div>
    <div id="status-bar">
      <span id="status-text">Loading repository...</span>
    </div>
  </div>
  <div id="context-menu" class="context-menu hidden"></div>
<script>
${getScript()}
</script>
</body>
</html>`;
}

/**
 * Dark values, emitted twice by design.
 *
 * The panel is a sandboxed iframe and cannot see the app's theme, so on its own
 * the only question it can ask is prefers-color-scheme — the *OS* setting,
 * which is why a light app still showed a dark graph. The host now stamps
 * data-ppm-theme on this document and injects the app's own tokens
 * (src/web/components/extensions/webview-theme.ts); the media query is the
 * fallback for a host that says nothing, and it must not override an explicit
 * light. Values are a charcoal rather than near-black so the toolbar, the list
 * and the banded rows read as three surfaces instead of one slab.
 */
const DARK_TOKENS = `
  --bg: #16171c; --surface: #1d1f26; --text: #ecedf0; --subtext: #a2a5b0; --subtle: #6b6f7c;
  --border: #262932; --border2: #383c48; --selected: #1e293b;
  --band: color-mix(in srgb, var(--text) 6%, transparent);
`;

function getStyles(): string {
  return `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #ffffff; --surface: #f4f4f5; --text: #09090b; --subtext: #71717a; --subtle: #a1a1aa;
  --border: #e4e4e7; --border2: #d4d4d8; --blue: #3b82f6; --red: #ef4444; --green: #22c55e;
  --yellow: #eab308; --purple: #8b5cf6; --orange: #f97316;
  --selected: #eff6ff;
  /* Zebra banding. Stronger in dark below, because the same percentage is not
     equally visible in both directions: a wash of near-black over white shows
     up where the same lift of near-white over a near-black row does not, which
     is what left the list looking like one flat slab. */
  --band: color-mix(in srgb, var(--text) 3.5%, transparent);
  /* Derived, never injected: the app has no hover token and some of its themes
     give the same colour to both panel surfaces, which would leave a hovered
     row looking untouched. A tint of the text colour flips with the mode and
     stacks on top of the zebra banding instead of replacing it. */
  --surface-hover: color-mix(in srgb, var(--text) 8%, transparent);
  /* Width of the branch/tag column. Fixed, because the graph is one SVG overlay
     drawn on a single grid and it starts where this column ends. */
  --refs-col-w: 170px;

  ${FONT_TOKENS}
}
:root[data-ppm-theme="dark"] { ${DARK_TOKENS} }
@media (prefers-color-scheme: dark) {
  :root:not([data-ppm-theme="light"]) { ${DARK_TOKENS} }
}
body { font-family: var(--ui-font); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; background: var(--bg); color: var(--text); font-size: 12px; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
#app { display: flex; flex-direction: column; height: 100vh; }

/* Toolbar */
#toolbar { display: flex; justify-content: space-between; align-items: center; padding: 4px 10px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 4px; }
select { background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 3px 6px; font-size: 11px; }
button { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 3px 8px; font-size: 11px; cursor: pointer; min-width: 24px; min-height: 24px; transition: background 0.15s, border-color 0.15s; }
button:hover { background: var(--surface-hover); border-color: var(--border2); }
button:active { background: var(--surface); }
.btn-fetching { opacity: 0.6; pointer-events: none; }

/* Branch dropdown */
.branch-dropdown { position: relative; }
.branch-trigger { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 3px 22px 3px 7px; font-size: 11px; cursor: pointer; min-width: 120px; text-align: left; position: relative; }
.branch-trigger::after { content: '\\25BC'; font-size: 8px; position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--subtext); }
.branch-dropdown-menu { position: absolute; top: 100%; left: 0; z-index: 60; background: var(--surface); border: 1px solid var(--border2); border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); min-width: 220px; max-height: 300px; display: flex; flex-direction: column; margin-top: 2px; }
.branch-filter-input { padding: 4px 7px; border: none; border-bottom: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 11px; outline: none; border-radius: 5px 5px 0 0; }
.branch-list { overflow-y: auto; max-height: 250px; }
.branch-option { padding: 4px 8px; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 5px; }
.branch-option:hover { background: var(--surface-hover); }
.branch-option.selected { background: var(--selected); font-weight: 600; }

/* Worktree popover */
.worktree-dropdown { position: relative; }
#btn-worktree { display: flex; align-items: center; gap: 3px; font-size: 11px; padding: 3px 6px; }
#btn-worktree .wt-count { background: var(--accent, #58a6ff); color: #fff; font-size: 9px; border-radius: 7px; padding: 0 4px; min-width: 14px; text-align: center; line-height: 14px; }
.worktree-popover { position: absolute; top: 100%; right: 0; z-index: 60; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); min-width: 300px; max-width: 400px; margin-top: 4px; display: flex; flex-direction: column; }
.worktree-popover-header { padding: 8px 12px; font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--border); }
.worktree-list { overflow-y: auto; max-height: 240px; }
.wt-item { padding: 8px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; font-size: 12px; }
.wt-item:last-child { border-bottom: none; }
.wt-item-info { flex: 1; min-width: 0; }
.wt-item-branch { font-weight: 600; display: flex; align-items: center; gap: 4px; }
.wt-item-path { font-size: 10px; color: var(--subtext); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-badge { font-size: 9px; padding: 1px 4px; border-radius: 4px; background: var(--border); color: var(--subtext); }
.wt-badge-current { background: var(--accent, #58a6ff); color: #fff; }
.wt-item-active { background: var(--selected); }
.wt-badge-locked { background: #d29922; color: #fff; }
.wt-item-actions { display: flex; gap: 4px; flex-shrink: 0; }
.wt-item-actions button { min-width: 24px; min-height: 24px; padding: 2px 6px; font-size: 10px; }
.worktree-popover-footer { padding: 8px 12px; border-top: 1px solid var(--border); display: flex; gap: 6px; }
.worktree-popover-footer .btn-sm { flex: 1; }
.wt-empty { padding: 16px; text-align: center; font-size: 11px; color: var(--subtext); }

/* Submodules reuse the worktree popover chrome; only the badges differ. */
.submodule-dropdown { position: relative; }
#btn-submodule { display: flex; align-items: center; gap: 3px; font-size: 11px; padding: 3px 6px; }
#btn-submodule .sm-count { background: var(--accent, #58a6ff); color: #fff; font-size: 9px; border-radius: 7px; padding: 0 4px; min-width: 14px; text-align: center; line-height: 14px; }
.sm-badge-uninitialized { background: var(--border); color: var(--subtext); }
.sm-badge-modified { background: #d29922; color: #fff; }
.sm-badge-conflicted { background: #f85149; color: #fff; }
@media (max-width: 768px) { .branch-option { padding: 10px 12px; min-height: 44px; } }

/* Stash popover */
.stash-dropdown { position: relative; }
#btn-stash { display: flex; align-items: center; gap: 3px; font-size: 11px; padding: 3px 6px; }
#btn-stash .stash-count { background: var(--accent, #58a6ff); color: #fff; font-size: 9px; border-radius: 7px; padding: 0 4px; min-width: 14px; text-align: center; line-height: 14px; }
.stash-popover { position: absolute; top: 100%; right: 0; z-index: 60; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.2); min-width: 300px; max-width: 400px; margin-top: 4px; display: flex; flex-direction: column; }
.stash-popover-header { padding: 8px 12px; font-size: 12px; font-weight: 600; border-bottom: 1px solid var(--border); }
.stash-list { overflow-y: auto; max-height: 240px; }
.stash-item { padding: 8px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; font-size: 12px; }
.stash-item:last-child { border-bottom: none; }
.stash-item-info { flex: 1; min-width: 0; }
.stash-item-ref { font-weight: 600; font-size: 11px; color: var(--subtext); }
.stash-item-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stash-item-actions { display: flex; gap: 4px; flex-shrink: 0; }
.stash-item-actions button { min-width: 24px; min-height: 24px; padding: 2px 6px; font-size: 10px; }
.stash-empty { padding: 16px; text-align: center; font-size: 11px; color: var(--subtext); }
.stash-popover-footer { padding: 8px 12px; border-top: 1px solid var(--border); display: flex; gap: 6px; }
.stash-popover-footer .btn-sm { flex: 1; }

/* Merge/rebase banner */
.merge-banner { padding: 8px 12px; background: rgba(133, 77, 14, 0.12); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; font-size: 12px; flex-shrink: 0; }
.merge-banner .banner-icon { color: #eab308; }
.merge-banner .banner-text { flex: 1; }
.merge-banner .banner-actions { display: flex; gap: 4px; }
.merge-banner .banner-actions button { font-size: 11px; padding: 2px 8px; }
.merge-banner .btn-continue { background: var(--green); color: #fff; border-color: transparent; }
.merge-banner .btn-abort { background: var(--red); color: #fff; border-color: transparent; }

/* Conflict section */
.conflict-header { padding: 4px 0; font-size: 12px; font-weight: 600; color: var(--red); display: flex; align-items: center; gap: 4px; }
.file-status-U { color: var(--red); font-weight: bold; }

/* Find bar */
.find-bar { display: flex; align-items: center; gap: 5px; padding: 4px 10px; border-bottom: 1px solid var(--border); background: var(--surface); }
.find-bar input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 3px 6px; font-size: 11px; }
.find-bar input:focus { outline: none; border-color: var(--blue); }
#find-count { font-size: 10px; color: var(--subtext); min-width: 50px; }
.hidden { display: none !important; }

/* Graph container. The scroller is wrapped, because the scroll markers have to
   sit beside it in a box that does not scroll with the rows. */
#graph-area { position: relative; flex: 1; min-height: 0; display: flex; }
#graph-container { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; }
/* Where in the whole history the things worth scrolling to are: the checked-out
   commit, the selected row, and every search match. Over the scrollbar, like
   VS Code's own overview ruler, and never clickable — dragging the scrollbar
   underneath has to keep working. */
#scroll-markers { position: absolute; right: 0; top: 0; bottom: 0; width: 5px; pointer-events: none; z-index: 3; }
.scroll-marker { position: absolute; right: 0; width: 5px; height: 2px; border-radius: 1px; transform: translateY(-50%); }
.sm-search { background: var(--yellow); }
.sm-head { background: var(--green); height: 3px; }
.sm-selected { background: var(--blue); height: 3px; }
.commit-row { display: flex; align-items: center; cursor: pointer; height: 30px; padding: 0 6px; font-size: 12px; box-sizing: border-box; overflow: hidden; }
/* Banding, before the hover and selected rules on purpose: it has the same
   specificity as they do, so source order is what decides the winner. Do not
   qualify it with #commit-list — an id would raise it above both of them and
   every other row would stop showing hover and selection. The header row is a
   .commit-row too but is the first child of its own parent, so it is odd. */
.commit-row:nth-child(even) { background: var(--band); }
.commit-row:hover { background: var(--surface-hover); }
.commit-row.header-row { background: var(--surface); cursor: default; font-weight: 600; font-size: 10px; color: var(--subtext); text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; z-index: 2; border-bottom: 1px solid var(--border); height: 24px; }
.commit-row.header-row .col-message::before { display: none; }
/* A tint and a bar, not a flood: with fifteen rows on screen a 15% yellow
   wash over half of them buried the list it was meant to annotate. The
   scroll markers carry where the rest of the matches are. */
.commit-row.search-match { background: color-mix(in srgb, var(--yellow) 9%, transparent); box-shadow: inset 2px 0 0 var(--yellow); }
/* After the match rule on purpose: the row you clicked should look selected,
   even when it is also a match. Which of the two it is stays visible in the
   find bar's count and in the scroll markers. */
.commit-row.selected { background: var(--selected); box-shadow: inset 2px 0 0 var(--blue); }
.commit-row.virtual { opacity: 0.85; font-style: italic; }
.commit-row.virtual .col-message { color: var(--subtext); }
.commit-row.stash-row { opacity: 0.75; }
.commit-row.stash-row .col-message { color: var(--subtext); font-style: italic; }
.file-clickable { cursor: pointer; border-radius: 3px; padding: 2px 4px; margin: 0 -4px; }
.file-clickable:hover { background: var(--surface-hover); }
/* Refs get a column of their own so every message starts at the same x — a
   branch badge pushing the text right was most of why the list read as ragged.
   The width has to be fixed rather than content-sized: rows are separate flex
   containers, so an auto width would put each row's graph at a different x, and
   the graph is one SVG overlay drawn on a single grid. */
.col-refs { width: var(--refs-col-w, 170px); min-width: var(--refs-col-w, 170px); flex-shrink: 0; overflow: hidden; white-space: nowrap; display: flex; align-items: center; justify-content: flex-end; gap: 3px; padding-right: 6px; }
.col-refs .ref-badge { min-width: 0; overflow: hidden; text-overflow: ellipsis; margin-right: 0; }
.col-graph { width: var(--graph-col-w, 120px); min-width: var(--graph-col-w, 80px); overflow: hidden; flex-shrink: 0; position: relative; }
.graph-resize-handle { position: absolute; right: 0; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 3; background: transparent; }
.graph-resize-handle:hover, .graph-resize-handle.dragging { background: var(--blue); opacity: 0.5; }
.col-message { flex: 1; min-width: 0; padding: 0 6px 0 12px; position: relative; display: flex; flex-direction: column; justify-content: center; align-self: stretch; overflow: hidden; }
/* The lane's colour, restated where the eye reads the message. The row centres
   its cells, so this one has to stretch or the tick has nothing to span. */
.col-message::before { content: ''; position: absolute; left: 3px; top: 7px; bottom: 7px; width: 2px; border-radius: 1px; background: var(--lane, transparent); opacity: 0.65; }
.msg-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Author, date and hash again, for the phone layout that has no room for their
   columns. Hidden until that layout asks for it. */
.msg-meta { display: none; }
/* Lines added and removed. Tabular figures so the columns of digits line up
   down the list rather than jittering with the glyph widths. */
.col-changes { width: 84px; min-width: 84px; flex-shrink: 0; font-size: 11px; font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 5px; }
.col-changes .ch-add { color: var(--green); }
.col-changes .ch-del { color: var(--red); }
.col-author { width: 130px; min-width: 130px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--subtext); font-size: 11px; }
.avatar { width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 7px; font-weight: 700; color: #fff; flex-shrink: 0; letter-spacing: -0.2px; }

/* Author hover card */
.author-card { position: fixed; z-index: 80; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); padding: 8px 10px; font-size: 11px; max-width: 280px; pointer-events: none; }
.author-card .ac-head { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 4px; }
.author-card .ac-row { color: var(--subtext); font-size: 10px; }

/* Drag a ref badge onto a commit row to merge or rebase onto it */
.ref-badge[draggable=true] { cursor: grab; }
.commit-row.drop-target { outline: 2px dashed var(--blue); outline-offset: -2px; background: var(--selected); }
.ref-badge.dragging { opacity: 0.45; }

/* Whole-history search results */
.search-results { position: absolute; top: 56px; left: 8px; right: 8px; max-height: 55vh; z-index: 45; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); overflow: auto; }
.sr-head { padding: 6px 10px; font-size: 10px; color: var(--subtext); border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); }
.sr-item { padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.sr-item:hover { background: var(--surface-hover); }
.sr-subject { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sr-meta { font-size: 10px; color: var(--subtext); display: flex; gap: 6px; align-items: center; margin-top: 2px; }
.sr-hash { font-family: var(--mono-font); }
.col-date { width: 80px; min-width: 80px; color: var(--subtext); font-size: 11px; }
.col-hash { width: 60px; min-width: 60px; font-family: var(--mono-font); font-size: 10px; color: var(--subtle); }

/* Ref badges — border + tinted bg + dark text */
.ref-badge { display: inline-flex; align-items: center; gap: 3px; padding: 0px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; margin-right: 3px; vertical-align: middle; line-height: 16px; border: 1px solid; color: #1a1a1a; }
.ref-head { border-color: var(--green); background: color-mix(in srgb, var(--green) 12%, transparent); }
.ref-local { border-color: var(--blue); background: color-mix(in srgb, var(--blue) 12%, transparent); }
.ref-remote { border-color: var(--purple); background: color-mix(in srgb, var(--purple) 12%, transparent); }
.ref-tag { border-color: var(--yellow); background: color-mix(in srgb, var(--yellow) 12%, transparent); }
.ref-stash { border-color: #808080; background: color-mix(in srgb, #808080 12%, transparent); }
:root[data-ppm-theme="dark"] .ref-badge { color: #e4e4e7; }
@media (prefers-color-scheme: dark) {
  :root:not([data-ppm-theme="light"]) .ref-badge { color: #e4e4e7; }
}

/* SVG graph — single SVG overlay */
#commit-list-wrapper { position: relative; }
#graph-svg-container { position: absolute; top: 0; left: calc(var(--refs-col-w, 170px) + 8px); z-index: 1; pointer-events: none; }
#graph-svg-container circle { pointer-events: auto; cursor: pointer; }
#graph-svg-container .line { stroke-width: 2; fill: none; }
/* The checked-out commit wears a thicker ring rather than a different shape,
   so it still reads as the same kind of thing as every row above it. */
#graph-svg-container .graphCurrent { stroke-width: 3.5; }
#graph-svg-container .node-initials { font-size: 8px; font-weight: 700; fill: #fff; pointer-events: none; user-select: none; letter-spacing: -0.3px; }
.commit-row.graph-hover { background: var(--surface-hover); }

/* Detail panel. The panel itself carries no padding, because the header is a
   full-width sticky bar and each pane below it pads itself; anything else
   written into the panel wraps itself in .detail-pad. */
.detail-panel { border-top: 1px solid var(--border2); background: var(--surface); max-height: 40vh; overflow-y: auto; flex-shrink: 0; }
.detail-panel h3 { font-size: 13px; margin-bottom: 6px; }
.detail-pad { padding: 8px 12px; }

.detail-head { display: flex; align-items: center; gap: 8px; padding: 7px 12px; border-bottom: 1px solid var(--border); background: var(--surface); position: sticky; top: 0; z-index: 2; flex-shrink: 0; }
.detail-head .avatar { width: 20px; height: 20px; font-size: 8px; }
.detail-who { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.detail-author { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-when { font-size: 11px; color: var(--subtext); white-space: nowrap; }
.detail-head-actions { margin-left: auto; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

/* A hash is a chip you can copy, not a 40-character field label. */
.chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px; border: 1px solid var(--border2); border-radius: 5px; background: var(--bg); color: var(--subtext); font-family: var(--mono-font); font-size: 10px; }
.chip-label { font-family: var(--ui-font); font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--subtle); }
.chip.copyable { cursor: pointer; }
.chip.copyable:hover { color: var(--text); border-color: var(--blue); }
.chip.copied { color: var(--green); border-color: var(--green); }

/* Two columns when there is room. A commit message is hard-wrapped by whoever
   wrote it, so on a wide panel it fills half the width and the rest of the row
   is empty; the file list goes there instead of below the fold. Each pane pads
   itself, because above the breakpoint each one also scrolls itself. */
.detail-grid { display: grid; grid-template-columns: minmax(0, 1fr); }
.detail-msg { padding: 12px 16px 16px; min-width: 0; }
.detail-files { padding: 8px 12px 12px; min-width: 0; }
/* Full hashes, both emails and both dates, in a label/value grid. One rule
   under it separates the provenance from the message; the subject carries none
   of its own, because two hairlines in a 360px panel is a lot of furniture and
   14px semibold against 11.5px monospace already reads as two things. The rule
   belongs here rather than to the body, which is capped at a readable measure
   and would stop the border short of the pane for no visible reason. */
.detail-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 14px; align-items: baseline; font-size: 11.5px; margin-bottom: 14px; padding-bottom: 13px; border-bottom: 1px solid var(--border); }
.meta-label { color: var(--subtext); font-size: 11.5px; white-space: nowrap; }
.meta-cells { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 14px; min-width: 0; }
.meta-value { min-width: 0; overflow-wrap: anywhere; cursor: pointer; }
.meta-value.mono { font-family: var(--mono-font); font-size: 11.5px; color: var(--subtext); }
/* The eight characters that identify the commit carry the contrast; the other
   thirty-two are there to be copied, not read. */
.hash-lead { color: var(--text); font-weight: 600; }
.meta-name { color: var(--text); }
.meta-email { color: var(--subtext); margin-left: 6px; }
.meta-value:hover .hash-lead, .meta-value:hover .meta-name, .meta-value:hover .meta-email { color: var(--blue); }
.meta-value:hover { color: var(--blue); }
.meta-value.copied, .meta-value.copied .hash-lead, .meta-value.copied .meta-name, .meta-value.copied .meta-email { color: var(--green); }
.meta-when { color: var(--subtext); font-variant-numeric: tabular-nums; }
.detail-subject { font-size: 15px; font-weight: 600; line-height: 1.4; letter-spacing: -0.1px; }

/* The body. A paragraph its author wrapped at 72 columns is set as prose in the
   UI font and reflowed to the pane it is actually in — verbatim monospace gave
   a ragged half-filled column of the wrong width. A list or an aligned block is
   not reflowable and keeps its breaks and its monospace; splitCommitBody
   decides which is which. */
.detail-text { margin-top: 13px; }
.msg-p { font-size: 13px; line-height: 1.7; max-width: 68ch; }
.msg-pre { font-family: var(--mono-font); font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
/* The reset zeroes every margin, so the space between paragraphs is set here
   rather than inherited from the browser's default for a p element. */
.msg-p + .msg-p, .msg-p + .msg-pre, .msg-pre + .msg-p, .msg-pre + .msg-pre { margin-top: 13px; }

/* One scrollbar per pane above the breakpoint. A long message and a long file
   list are two lists of unrelated length, and scrolling the pair as one means
   reaching the twentieth file by pushing the message off the screen. Below it
   they are stacked, and two scrollers inside one short panel is a trap for a
   thumb — so there the panel scrolls as a whole, as it always did. */
@media (min-width: 900px) {
  .detail-panel.split { display: flex; flex-direction: column; overflow: hidden; }
  .detail-grid.has-files { grid-template-columns: minmax(0, 1fr) minmax(260px, 38%); }
  .detail-panel.split .detail-grid { flex: 1 1 auto; min-height: 0; }
  .detail-panel.split .detail-grid > * { overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
  .detail-panel.split .detail-files { border-left: 1px solid var(--border); padding-top: 0; }
  /* The pane's own top padding would sit above a sticky header, leaving a strip
     for rows to scroll through; the header carries that space instead. */
  .detail-panel.split .files-head { position: sticky; top: 0; background: var(--surface); z-index: 1; padding: 8px 0 3px; }
}

.file-list { margin-top: 8px; min-width: 0; }
.detail-files .file-list { margin-top: 0; }
.files-head { display: flex; align-items: center; gap: 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--subtext); border-bottom: 1px solid var(--border); margin-bottom: 3px; }
.files-head .file-view-toggle { margin-bottom: 0; }
.files-total { margin-left: auto; font-family: var(--mono-font); font-size: 10px; letter-spacing: 0; text-transform: none; font-variant-numeric: tabular-nums; }
.files-total .add { color: var(--green); }
.files-total .del { color: var(--red); }

.file-item { display: flex; align-items: center; gap: 6px; padding: 2px 4px; border-radius: 4px; font-size: 11px; font-family: var(--mono-font); min-width: 0; }
.file-item.file-clickable { cursor: pointer; }
.file-item.file-clickable:hover { background: var(--surface-hover); }
/* Name first, then the directory it is in: the column is narrow, so what has
   to survive the ellipsis is the file name. */
.file-item .file-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; max-width: 60%; }
/* The directory takes the slack, which is what leaves the stats and the row's
   buttons together at the right edge instead of both claiming the same auto
   margin and meeting somewhere in the middle. */
.file-item .file-dir { color: var(--subtle); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
.file-status { display: inline-block; width: 14px; text-align: center; font-weight: 700; font-size: 10px; }
.file-status-A { color: var(--green); }
.file-status-M { color: var(--yellow); }
.file-status-D { color: var(--red); }
.file-status-R { color: var(--blue); }
.file-stat { color: var(--subtext); font-size: 11px; margin-left: auto; }
.file-stat .add { color: var(--green); }
.file-stat .del { color: var(--red); }

/* File view toggle */
.file-view-toggle { display: flex; gap: 2px; margin-bottom: 6px; }
.toggle-btn { padding: 2px 6px; font-size: 12px; min-width: 28px; min-height: 28px; border: 1px solid var(--border); border-radius: 4px; background: transparent; cursor: pointer; }
.toggle-btn.active { background: var(--surface-hover); border-color: var(--border2); }
.tree-dir { display: flex; align-items: center; gap: 4px; padding: 2px 0; font-size: 12px; color: var(--subtext); }
.tree-dir-name { font-weight: 500; color: var(--text); }
.tree-dir-count { font-size: 11px; color: var(--subtle); }

/* File actions */
.file-actions { display: flex; gap: 2px; margin-left: 6px; flex-shrink: 0; }
.file-action-btn { min-width: 24px; min-height: 24px; padding: 0 4px; border: none; background: transparent; cursor: pointer; border-radius: 4px; font-size: 12px; color: var(--subtext); display: flex; align-items: center; justify-content: center; }
.file-action-btn:hover { background: var(--surface-hover); color: var(--text); }
.file-action-btn[data-action="discard"]:hover { color: var(--red); }
.section-actions { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.commit-section { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
.commit-section textarea { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 6px; padding: 8px; font-size: 12px; font-family: inherit; resize: vertical; min-height: 60px; }
.commit-section textarea:focus { outline: none; border-color: var(--blue); }
.commit-actions { display: flex; justify-content: flex-end; margin-top: 6px; gap: 6px; }
.btn-commit { background: var(--green); color: #fff; border-color: transparent; padding: 4px 16px; font-weight: 600; }
.btn-commit:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-commit:hover:not(:disabled) { opacity: 0.9; }
@media (max-width: 768px) { .file-action-btn { min-width: 36px; min-height: 36px; } }

/* Status bar */
#status-bar { display: flex; align-items: center; padding: 4px 12px; border-top: 1px solid var(--border); background: var(--surface); font-size: 11px; color: var(--subtext); flex-shrink: 0; }

/* Context menu */
.context-menu { position: fixed; background: var(--surface); border: 1px solid var(--border2); border-radius: 6px; padding: 4px 0; min-width: 180px; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
.ctx-item { padding: 6px 12px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 8px; }
.ctx-item:hover { background: var(--surface-hover); }
.ctx-item.destructive { color: var(--red); }
.ctx-separator { border-top: 1px solid var(--border); margin: 4px 0; }

/* Loading */
.loading { text-align: center; padding: 16px; color: var(--subtext); }

/* Settings panel */
.settings-panel { position: absolute; right: 0; top: 0; bottom: 0; width: 340px; background: var(--surface); border-left: 1px solid var(--border2); z-index: 50; overflow-y: auto; transform: translateX(100%); transition: transform 0.2s ease; display: flex; flex-direction: column; }
.settings-panel.open { transform: translateX(0); }
.settings-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.settings-header h3 { font-size: 14px; font-weight: 600; }
.settings-body { flex: 1; overflow-y: auto; padding: 8px 0; }
.settings-section { border-bottom: 1px solid var(--border); padding: 8px 14px; }
.settings-section summary { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--subtext); cursor: pointer; padding: 4px 0; user-select: none; }
.settings-section[open] summary { margin-bottom: 6px; }
.setting-row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; font-size: 12px; gap: 8px; }
.setting-row label { flex: 1; min-width: 0; }
.setting-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--blue); flex-shrink: 0; }
.setting-row input[type="number"] { width: 72px; background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
.setting-row select { background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 3px 6px; font-size: 12px; min-width: 100px; }
.setting-row input[type="text"] { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
.btn-sm { font-size: 11px; padding: 3px 10px; border-radius: 6px; min-width: 0; min-height: 0; }
.remote-item { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.remote-item:last-child { border-bottom: none; }
.remote-item .remote-name { font-weight: 600; margin-bottom: 2px; }
.remote-item .remote-url { color: var(--subtext); font-family: var(--mono-font); font-size: 11px; word-break: break-all; }
.remote-actions { display: flex; gap: 4px; margin-top: 4px; }
.add-remote-form { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.add-remote-form input { background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 4px 6px; font-size: 12px; }
.issue-rule-row { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
.issue-rule-row input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 3px 6px; font-size: 11px; font-family: var(--mono-font); }
.issue-rule-row input.rule-error { border-color: var(--red); }
.issue-rule-row .rule-remove { min-width: 24px; min-height: 24px; padding: 0; font-size: 14px; color: var(--red); border: none; }
@media (max-width: 768px) { .settings-panel { width: 100%; } }

/* Dialog overlay */
.dialog-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 200; display: flex; align-items: center; justify-content: center; }
.dialog { background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; padding: 16px; min-width: 300px; max-width: 400px; box-shadow: 0 8px 24px rgba(0,0,0,0.2); }
.dialog h3 { font-size: 14px; margin-bottom: 12px; }
.dialog p { font-size: 12px; color: var(--subtext); margin-bottom: 12px; }
.dialog p.warning { color: var(--red); font-weight: 600; }
.dialog input, .dialog select { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 6px 8px; font-size: 12px; margin-bottom: 12px; }
.dialog input:focus, .dialog select:focus { outline: none; border-color: var(--blue); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dialog-actions button { min-width: 64px; }
.dialog-actions .btn-primary { background: var(--blue); color: #fff; border-color: transparent; }
.dialog-actions .btn-danger { background: var(--red); color: #fff; border-color: transparent; }

/* Links in commit messages */
.commit-link { color: var(--blue); text-decoration: none; cursor: pointer; }
.commit-link:hover { text-decoration: underline; }

/* Toast notifications */
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 8px 16px; border-radius: 6px; font-size: 12px; z-index: 300; animation: toast-in 0.3s ease; max-width: 80%; pointer-events: none; }
.toast-error { background: var(--red); color: #fff; }
.toast-success { background: var(--green); color: #fff; }
.toast-info { background: var(--blue); color: #fff; }
@keyframes toast-in { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

/* Touch devices — compact mobile layout */
@media (pointer: coarse) {
  .commit-row { height: 32px; }
  .ctx-item { padding: 8px 12px; min-height: 36px; }
  button { min-width: 32px; min-height: 32px; padding: 2px 6px; }
  #app { flex-direction: column; }
  #toolbar { order: 10; border-bottom: none; border-top: 1px solid var(--border); padding: 2px 6px; }
  #toolbar button { font-size: 10px; }
  .branch-trigger { font-size: 10px !important; padding: 2px 6px !important; }
  #graph-area { order: 1; }
  #graph-container { overflow-x: auto; overflow-y: auto; }
  #find-bar { order: 0; }
  #status-bar { order: 9; }
  /* Enough for every column including the branch one, so a tablet scrolls the
     table sideways rather than crushing it. */
  #commit-list-wrapper { min-width: 880px; }
  #graph-header { min-width: 880px; }
  .commit-row.header-row { min-height: 20px; }
  .detail-panel { order: 8; max-height: 35vh; }
}
/* Phone layout: the graph and the message, with author/date/hash under the
   subject. Six columns of fragments is not a list of commits, and 44px is the
   minimum touch target this row has to be anyway. isNarrowLayout() in the
   script uses this same 640px, because it decides where the ref badges go. */
@media (max-width: 640px) {
  :root { --refs-col-w: 0px; }
  /* The coarse-pointer rules above keep the whole table and scroll it
     sideways, which is right for a tablet. A phone gets the stacked row
     instead, so the minimum width that forces that scroll has to go. */
  #commit-list-wrapper, #graph-header { min-width: 0; }
  .commit-row { height: 44px; }
  .commit-row.header-row { height: 24px; }
  .col-refs, .col-changes, .col-author, .col-date, .col-hash { display: none; }
  .col-message { gap: 1px; }
  .msg-meta { display: block; font-size: 10px; color: var(--subtext); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-message .ref-badge { max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
  /* Two hash chips take half a phone's width and left the author's name as
     "t." with an ellipsis. They are a convenience, not the only copy of the
     hash — the metadata grid two lines below has both, in full. */
  .detail-head-actions { display: none; }
}
`;
}

function getScript(): string {
  return `
const vscode = acquireVsCodeApi();
const SVG_NS = 'http://www.w3.org/2000/svg';
const NULL_VERTEX_ID = -1;
const GRAPH_COLORS = ['#4ec9b0','#569cd6','#c586c0','#ce9178','#dcdcaa','#4fc1ff','#d7ba7d','#9cdcfe','#b5cea8','#d16969'];
const graphConfig = {
  colours: GRAPH_COLORS,
  // Wide enough apart that two adjacent lanes' author avatars do not touch,
  // and tall enough that an 18px avatar is the row rather than a dot in it.
  grid: { x: 22, y: 30, offsetX: 14, offsetY: 15, expandY: 60 },
  nodeR: 9,
  style: 'rounded'
};

// --- State ---
const DEFAULT_SETTINGS = {
  maxCommits: 300, showTags: true, showStashes: true, showRemoteBranches: true,
  graphStyle: 'rounded', firstParentOnly: false, dateFormat: 'relative', commitOrdering: 'topo',
  issueLinkingRules: [{ pattern: '#(\\\\d+)', url: '' }], prCreation: null,
  autoFetchInterval: 0,
};

const state = {
  repo: '',
  commits: [],
  branches: [],
  tags: [],
  remotes: [],
  stashes: [],
  currentBranch: '',
  head: '',
  selectedCommit: null,
  expandedCommit: null,
  maxCommits: 300,
  loading: false,
  uncommitted: null,
  searchMatches: [],
  /** hash -> {files, insertions, deletions}; arrives after the commits. */
  stats: {},
  searchIndex: -1,
  settings: { ...DEFAULT_SETTINGS },
  userDetails: { name: '', email: '' },
  graphColWidth: null,
  fileViewMode: 'list',
  worktrees: [],
  submodules: [],
  mergeState: null,
  _lastDetail: null,
};

// --- SVG Icons ---
const ICONS = {
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  folderOpen: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2l-1-5H4l-1 5a2 2 0 002 2z"/></svg>',
  file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>',
  list: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  tree: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>',
  plus: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  minus: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  fileOpen: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  gitBranch: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>',
  trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>',
  archive: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  history: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
};

// --- Toast notifications ---
function showToast(message, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'error');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
}

// --- Init ---
document.getElementById('btn-refresh').innerHTML = ICONS.refresh;
document.getElementById('btn-fetch').innerHTML = ICONS.download;
document.getElementById('btn-submodule').innerHTML = ICONS.folderOpen + ' <span class="sm-count" style="display:none">0</span>';
document.getElementById('btn-reflog').innerHTML = ICONS.history;
document.getElementById('btn-find').innerHTML = ICONS.search;
document.getElementById('btn-settings').innerHTML = ICONS.settings;
document.getElementById('btn-worktree').innerHTML = ICONS.gitBranch + ' <span class="wt-count" style="display:none">0</span>';
document.getElementById('btn-stash').innerHTML = ICONS.archive + ' <span class="stash-count" style="display:none">0</span>';
vscode.postMessage({ command: 'ready' });

// --- Message handler ---
/*
 * The row's layout is decided in JS as well as in CSS (the ref badges live in
 * their own column on a wide screen and inline on a narrow one), so crossing
 * the breakpoint has to rebuild the rows. Without this, rotating a phone would
 * leave the badges in a column that CSS has just hidden.
 */
let gWasNarrow = null;
window.addEventListener('resize', () => {
  const narrow = isNarrowLayout();
  if (gWasNarrow === narrow) return;
  gWasNarrow = narrow;
  if (state.commits.length > 0) renderCommitList();
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.command) {
    case 'loadSearchResults':
      renderSearchResults(msg.data);
      break;
    case 'loadRepoInfo':
      state.repo = msg.data.path;
      state.branches = msg.data.branches;
      state.tags = msg.data.tags;
      state.remotes = msg.data.remotes;
      state.stashes = msg.data.stashes;
      state.head = msg.data.head;
      state.currentBranch = msg.data.currentBranch;
      renderBranchSelector();
      updateStatus();
      if (document.getElementById('settings-panel').classList.contains('open')) renderRemotesList();
      break;
    case 'loadCommits':
      if (msg.append) {
        state.commits = state.commits.concat(msg.data);
      } else {
        state.commits = msg.data;
      }
      renderCommitList();
      updateStatus();
      state.loading = false;
      document.getElementById('loading').classList.add('hidden');
      break;
    case 'loadCommitStats':
      Object.assign(state.stats, msg.data);
      applyCommitStats();
      break;
    case 'commitDetails':
      renderDetailPanel(msg.data);
      break;
    case 'refresh':
      state.commits = msg.data;
      if (msg.repoInfo) {
        state.branches = msg.repoInfo.branches;
        state.tags = msg.repoInfo.tags;
        state.remotes = msg.repoInfo.remotes;
        state.stashes = msg.repoInfo.stashes;
        state.head = msg.repoInfo.head;
        state.currentBranch = msg.repoInfo.currentBranch;
        renderBranchSelector();
      }
      renderCommitList();
      updateStatus();
      break;
    case 'loadUncommitted':
      state.uncommitted = msg.data;
      state.mergeState = msg.data?.mergeState || null;
      renderCommitList();
      renderMergeBanner();
      if (state.selectedCommit === 'uncommitted') {
        const u = msg.data;
        if (!u || (u.staged.length === 0 && u.unstaged.length === 0 && (!u.conflicted || u.conflicted.length === 0))) {
          state.selectedCommit = null;
          state.expandedCommit = null;
          document.getElementById('detail-panel').classList.add('hidden');
        } else {
          renderUncommittedDetail();
        }
      }
      break;
    case 'loadSearchResults':
      renderSearchResults(msg.data);
      break;
    case 'loadSettings':
      state.settings = { ...DEFAULT_SETTINGS, ...msg.data };
      state.maxCommits = state.settings.maxCommits;
      applySettingsToUI();
      break;
    case 'loadUserDetails':
      state.userDetails = msg.data;
      document.getElementById('s-userName').value = msg.data.name;
      document.getElementById('s-userEmail').value = msg.data.email;
      break;
    case 'loadOwnerRepo':
      if (msg.data.owner) document.getElementById('pr-owner').value = msg.data.owner;
      if (msg.data.repo) document.getElementById('pr-repo').value = msg.data.repo;
      break;
    case 'actionResult':
      if (msg.action === 'fetch') {
        fetchInProgress = false;
        btnFetch.classList.remove('btn-fetching');
        btnFetch.title = 'Fetch from remotes';
        if (!msg.result.ok) {
          document.getElementById('status-text').textContent = 'Fetch failed: ' + (msg.result.error || 'Unknown error');
        }
      } else if (!msg.result.ok && msg.action === 'createBranch' && msg.result.error && msg.result.error.includes('already exists')) {
        // Extract branch name from error: "fatal: a branch named 'X' already exists"
        const branchMatch = msg.result.error.match(/branch named '([^']+)'/);
        const branchName = branchMatch ? branchMatch[1] : 'this branch';
        showDialog({
          title: 'Branch Already Exists',
          message: 'A branch named <b>' + escHtml(branchName) + '</b> already exists, do you want to replace it with this new branch?',
          rawMessage: true,
          confirmLabel: 'Yes, replace the existing branch',
          cancelLabel: 'No, choose another branch name',
          onConfirm: () => gitAction('createBranch', { ...msg.args, force: true }),
        });
      } else if (!msg.result.ok) {
        showToast('Git action failed: ' + (msg.result.error || 'Unknown error'), 'error');
      }
      // Refresh worktree list after worktree mutations
      if (msg.result.ok && (msg.action === 'addWorktree' || msg.action === 'removeWorktree' || msg.action === 'pruneWorktrees')) {
        vscode.postMessage({ command: 'requestWorktrees' });
      }
      // Refresh stash list after stash mutations
      if (msg.result.ok && ['stashSave','stashPop','stashDrop','stashApply'].includes(msg.action)) {
        vscode.postMessage({ command: 'requestStashes' });
      }
      break;
    case 'loadWorktrees':
      state.worktrees = msg.data || [];
      renderWorktreeList();
      break;
    case 'loadSubmodules':
      state.submodules = msg.data || [];
      renderSubmoduleList();
      break;
    case 'loadStashes':
      state.stashes = msg.data || [];
      renderStashList();
      if (state.commits.length > 0) renderCommitList();
      break;
    case 'error':
      document.getElementById('status-text').textContent = 'Error: ' + msg.message;
      break;
  }
});

// --- File context menu: blame / history for one file ---
function showFileContextMenu(x, y, filePath, hash) {
  const items = [
    { label: 'Blame this file', action: () => vscode.postMessage({ command: 'openBlame', filePath }) },
  ];
  if (hash && hash !== 'uncommitted' && hash !== 'staged') {
    items.push({ label: 'Blame at ' + hash.substring(0, 7), action: () => vscode.postMessage({ command: 'openBlame', filePath, hash }) });
  }
  items.push(
    { label: 'File history', action: () => vscode.postMessage({ command: 'openFileHistory', filePath }) },
    { separator: true },
    { label: 'Open file', action: () => vscode.postMessage({ command: 'openFile', filePath }) },
  );
  renderContextMenu(x, y, items);
}

document.getElementById('detail-panel').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.file-item');
  if (!item || !item.dataset.path) return;
  e.preventDefault();
  e.stopPropagation();
  showFileContextMenu(e.clientX, e.clientY, item.dataset.path, item.dataset.hash);
});

// --- File click delegation (opens diff tab) ---
document.getElementById('detail-panel').addEventListener('click', (e) => {
  // Hash chips and metadata values. The clipboard write is silent, so the
  // thing clicked says it happened.
  const copySource = e.target.closest('[data-copy]');
  if (copySource) {
    e.stopPropagation();
    copyText(copySource.dataset.copy);
    copySource.classList.add('copied');
    setTimeout(() => copySource.classList.remove('copied'), 900);
    return;
  }
  // File-level action buttons (stage/unstage/discard/open)
  const actionBtn = e.target.closest('.file-action-btn');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    const file = actionBtn.dataset.file;
    if (action === 'open') {
      vscode.postMessage({ command: 'openFile', filePath: file });
    } else if (action === 'open-conflict') {
      vscode.postMessage({ command: 'openConflictFile', filePath: file });
    } else if (action === 'stage') {
      vscode.postMessage({ command: 'gitAction', action: 'stage', args: { files: [file] } });
    } else if (action === 'unstage') {
      vscode.postMessage({ command: 'gitAction', action: 'unstage', args: { files: [file] } });
    } else if (action === 'discard') {
      showDialog({
        title: 'Discard Changes',
        message: 'Discard changes to "' + file + '"? This cannot be undone.',
        destructive: true,
        confirmLabel: 'Discard',
        onConfirm: () => vscode.postMessage({ command: 'gitAction', action: 'discard', args: { files: [file] } }),
      });
    }
    return;
  }
  // Section-level actions (Stage All / Unstage All)
  const sectionBtn = e.target.closest('.section-action-btn');
  if (sectionBtn) {
    e.stopPropagation();
    const action = sectionBtn.dataset.action;
    if (action === 'stage-all') {
      const files = state.uncommitted.unstaged.map(f => f.path);
      vscode.postMessage({ command: 'gitAction', action: 'stage', args: { files } });
    } else if (action === 'unstage-all') {
      const files = state.uncommitted.staged.map(f => f.path);
      vscode.postMessage({ command: 'gitAction', action: 'unstage', args: { files } });
    }
    return;
  }
  // Toggle buttons (tree/list view)
  const toggleBtn = e.target.closest('.toggle-btn[data-view]');
  if (toggleBtn) {
    state.fileViewMode = toggleBtn.dataset.view;
    if (state.selectedCommit === 'uncommitted') {
      renderUncommittedDetail();
    } else if (state._lastDetail) {
      renderDetailPanel(state._lastDetail);
    }
    return;
  }
  // File click (opens diff)
  const item = e.target.closest('.file-clickable');
  if (!item) return;
  const filePath = item.dataset.path;
  const hash = item.dataset.hash;
  const parentHash = item.dataset.parent || null;
  if (filePath && hash) {
    vscode.postMessage({ command: 'openDiff', filePath, hash, parentHash });
  }
});

/* Blame and history are per-file, so the commit detail's file list is the
   natural place to reach them. */
function showFileContextMenu(x, y, filePath, hash) {
  const committed = hash && hash !== 'uncommitted' && hash !== 'staged';
  const items = [
    { label: 'Blame this file', action: () => vscode.postMessage({ command: 'openBlame', filePath }) },
  ];
  if (committed) {
    items.push({ label: 'Blame at ' + hash.substring(0, 7), action: () => vscode.postMessage({ command: 'openBlame', filePath, hash }) });
  }
  items.push(
    { label: 'File history', action: () => vscode.postMessage({ command: 'openFileHistory', filePath }) },
    { separator: true },
    { label: 'Open file', action: () => vscode.postMessage({ command: 'openFile', filePath }) },
  );
  renderContextMenu(x, y, items);
}

document.getElementById('detail-panel').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.file-clickable');
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  showFileContextMenu(e.clientX, e.clientY, item.dataset.path || item.dataset.file, item.dataset.hash);
});

/* Touch has no right-click, and the detail panel re-renders on every selection,
   so the long-press is delegated rather than bound per row. */
(function setupFileLongPress() {
  const panel = document.getElementById('detail-panel');
  let timer = null, startX = 0, startY = 0, target = null;
  panel.addEventListener('touchstart', (e) => {
    target = e.target.closest('.file-clickable');
    if (!target) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = setTimeout(() => {
      e.preventDefault();
      showFileContextMenu(startX, startY, target.dataset.path || target.dataset.file, target.dataset.hash);
      target = null;
    }, 500);
  }, { passive: false });
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  panel.addEventListener('touchmove', (e) => {
    if (timer && (Math.abs(e.touches[0].clientX - startX) > 10 || Math.abs(e.touches[0].clientY - startY) > 10)) cancel();
  }, { passive: true });
  panel.addEventListener('touchend', cancel);
  panel.addEventListener('touchcancel', cancel);
})();

// --- Branch dropdown ---
let selectedBranch = 'all';
const branchTrigger = document.getElementById('branch-trigger');
const branchMenu = document.getElementById('branch-dropdown-menu');
const branchFilterInput = document.getElementById('branch-filter');
const branchListEl = document.getElementById('branch-list');

branchTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const wasHidden = branchMenu.classList.contains('hidden');
  branchMenu.classList.toggle('hidden');
  if (wasHidden) {
    branchFilterInput.value = '';
    renderBranchOptions('');
    branchFilterInput.focus();
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#branch-selector')) branchMenu.classList.add('hidden');
});

branchFilterInput.addEventListener('input', () => {
  renderBranchOptions(branchFilterInput.value.toLowerCase());
});
branchFilterInput.addEventListener('click', (e) => e.stopPropagation());

function renderBranchOptions(filter) {
  const options = [{ name: 'all', label: 'All Branches', current: false }];
  state.branches.forEach(b => {
    if (b.remote && !state.settings.showRemoteBranches) return;
    options.push({ name: b.name, label: (b.current ? '* ' : '') + b.name, current: b.current });
  });
  const filtered = filter ? options.filter(o => o.label.toLowerCase().includes(filter)) : options;
  branchListEl.innerHTML = filtered.map(o =>
    '<div class="branch-option' + (o.name === selectedBranch ? ' selected' : '') + '" data-branch="' + escHtml(o.name) + '">' + escHtml(o.label) + '</div>'
  ).join('');
}

branchListEl.addEventListener('click', (e) => {
  const opt = e.target.closest('.branch-option');
  if (!opt) return;
  const branch = opt.dataset.branch;
  selectedBranch = branch;
  branchTrigger.textContent = branch === 'all' ? 'All Branches' : branch;
  branchMenu.classList.add('hidden');
  state.commits = [];
  document.getElementById('commit-list').innerHTML = '';
  vscode.postMessage({ command: 'requestCommits', branch, maxCommits: state.maxCommits });
});

function renderBranchSelector() {
  const branchNames = state.branches.map(b => b.name);
  if (selectedBranch !== 'all' && !branchNames.includes(selectedBranch)) selectedBranch = 'all';
  branchTrigger.textContent = selectedBranch === 'all' ? 'All Branches' : selectedBranch;
}

// --- Refresh ---
document.getElementById('btn-refresh').addEventListener('click', () => {
  state.commits = [];
  document.getElementById('commit-list').innerHTML = '';
  vscode.postMessage({ command: 'requestRepoInfo' });
  vscode.postMessage({ command: 'requestCommits', maxCommits: state.maxCommits });
});

// --- Fetch ---
const btnFetch = document.getElementById('btn-fetch');
let fetchInProgress = false;
let autoFetchTimer = null;

function doFetch() {
  fetchInProgress = true;
  btnFetch.classList.add('btn-fetching');
  btnFetch.title = 'Fetching...';
  vscode.postMessage({ command: 'gitAction', action: 'fetch', args: { prune: true } });
}

btnFetch.addEventListener('click', () => { if (!fetchInProgress) doFetch(); });

function startAutoFetch(intervalSec) {
  stopAutoFetch();
  if (!intervalSec || intervalSec <= 0) return;
  const ms = Math.max(intervalSec, 10) * 1000;
  autoFetchTimer = setInterval(() => { if (!fetchInProgress) doFetch(); }, ms);
}
function stopAutoFetch() {
  if (autoFetchTimer) { clearInterval(autoFetchTimer); autoFetchTimer = null; }
}

// --- Worktree popover ---
const wtPopover = document.getElementById('worktree-popover');
const btnWorktree = document.getElementById('btn-worktree');

btnWorktree.addEventListener('click', (e) => {
  e.stopPropagation();
  const wasHidden = wtPopover.classList.contains('hidden');
  wtPopover.classList.toggle('hidden');
  if (wasHidden) vscode.postMessage({ command: 'requestWorktrees' });
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.worktree-dropdown')) wtPopover.classList.add('hidden');
});

function renderWorktreeList() {
  const listEl = document.getElementById('worktree-list');
  const countEl = btnWorktree.querySelector('.wt-count');
  const wts = state.worktrees;
  if (countEl) {
    countEl.textContent = wts.length;
    countEl.style.display = wts.length > 1 ? '' : 'none';
  }
  if (!wts.length) {
    listEl.innerHTML = '<div class="wt-empty">No worktrees found</div>';
    return;
  }
  listEl.innerHTML = wts.map((wt, i) => {
    const branchName = wt.branch || (wt.isDetached ? 'detached HEAD' : '(bare)');
    const shortHash = wt.head ? wt.head.substring(0, 7) : '';
    const isCurrent = wt.path === state.repo;
    let badges = '';
    if (isCurrent) badges += ' <span class="wt-badge wt-badge-current">current</span>';
    if (wt.isMain && !isCurrent) badges += ' <span class="wt-badge">main</span>';
    if (wt.locked) badges += ' <span class="wt-badge wt-badge-locked">locked</span>';
    if (wt.prunable) badges += ' <span class="wt-badge">prunable</span>';
    if (wt.isDetached) badges += ' <span class="wt-badge">detached</span>';
    const actions = isCurrent ? ''
      : '<button class="wt-open" data-idx="' + i + '" title="Open in PPM">' + ICONS.fileOpen + '</button>'
        + (wt.isMain ? '' : '<button class="wt-remove" data-idx="' + i + '" title="Remove worktree">' + ICONS.trash + '</button>');
    return '<div class="wt-item' + (isCurrent ? ' wt-item-active' : '') + '">'
      + '<div class="wt-item-info">'
      + '<div class="wt-item-branch">' + ICONS.gitBranch + ' ' + escHtml(branchName) + badges + '</div>'
      + '<div class="wt-item-path" title="' + escHtml(wt.path) + '">' + escHtml(wt.path) + ' <span style="color:var(--subtle)">' + shortHash + '</span></div>'
      + '</div>'
      + (actions ? '<div class="wt-item-actions">' + actions + '</div>' : '')
      + '</div>';
  }).join('');

  // Bind action buttons
  listEl.querySelectorAll('.wt-open').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wt = state.worktrees[parseInt(btn.dataset.idx)];
      if (wt) vscode.postMessage({ command: 'openWorktree', path: wt.path });
    });
  });
  listEl.querySelectorAll('.wt-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wt = state.worktrees[parseInt(btn.dataset.idx)];
      if (!wt) return;
      showDialog({
        title: 'Remove Worktree',
        message: 'Remove worktree at "' + wt.path + '"?',
        destructive: true,
        confirmLabel: 'Remove',
        onConfirm: () => vscode.postMessage({ command: 'removeWorktree', path: wt.path }),
      });
    });
  });
}

/* --- Submodules ---
   The whole control stays hidden in the common case: most repositories have no
   submodules, and an always-visible empty dropdown is just noise in a toolbar
   that is already tight on a phone. */
const smWrap = document.getElementById('submodule-wrap');
const smPopover = document.getElementById('submodule-popover');
document.getElementById('btn-submodule').addEventListener('click', (e) => {
  e.stopPropagation();
  smPopover.classList.toggle('hidden');
  if (!smPopover.classList.contains('hidden')) vscode.postMessage({ command: 'requestSubmodules' });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.submodule-dropdown')) smPopover.classList.add('hidden');
});

const SM_STATE_TEXT = {
  current: 'up to date',
  uninitialized: 'not checked out',
  modified: 'differs from the recorded commit',
  conflicted: 'has merge conflicts',
};

function renderSubmoduleList() {
  const subs = state.submodules;
  smWrap.classList.toggle('hidden', subs.length === 0);
  if (!subs.length) { smPopover.classList.add('hidden'); return; }

  const stale = subs.filter((sm) => sm.state !== 'current').length;
  const countEl = document.getElementById('btn-submodule').querySelector('.sm-count');
  if (countEl) {
    countEl.textContent = stale || subs.length;
    countEl.style.display = '';
  }

  const listEl = document.getElementById('submodule-list');
  listEl.innerHTML = subs.map((sm, i) => {
    const badge = sm.state === 'current' ? ''
      : ' <span class="wt-badge sm-badge-' + escHtml(sm.state) + '">' + escHtml(sm.state) + '</span>';
    const name = sm.path.split('/').pop() || sm.path;
    return '<div class="wt-item">'
      + '<div class="wt-item-info">'
        + '<div class="wt-item-branch">' + escHtml(name) + badge + '</div>'
        + '<div class="wt-item-path" title="' + escHtml(SM_STATE_TEXT[sm.state] || '') + '">'
          + escHtml(sm.path) + ' <span style="color:var(--subtle)">' + escHtml(sm.hash.slice(0, 7)) + '</span>'
          + (sm.describe ? ' ' + escHtml(sm.describe) : '')
        + '</div>'
      + '</div>'
      + '<div class="wt-item-actions">'
        + '<button class="sm-update" data-idx="' + i + '" title="Checkout the recorded commit">' + ICONS.download + '</button>'
        + (sm.state === 'uninitialized' ? ''
            : '<button class="sm-open" data-idx="' + i + '" title="Open in PPM">' + ICONS.fileOpen + '</button>')
      + '</div>'
    + '</div>';
  }).join('');

  listEl.querySelectorAll('.sm-update').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sm = state.submodules[parseInt(btn.dataset.idx)];
      if (sm) vscode.postMessage({ command: 'updateSubmodule', path: sm.path });
    });
  });
  listEl.querySelectorAll('.sm-open').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sm = state.submodules[parseInt(btn.dataset.idx)];
      if (sm) vscode.postMessage({ command: 'openSubmodule', path: sm.path });
    });
  });
}

document.getElementById('sm-update-all').addEventListener('click', () => {
  showDialog({
    title: 'Update Submodules',
    message: 'Check out the recorded commit in every submodule? Local changes inside them are left alone, but the checkout moves.',
    confirmLabel: 'Update all',
    onConfirm: () => {
      for (const sm of state.submodules) vscode.postMessage({ command: 'updateSubmodule', path: sm.path });
    },
  });
});

document.getElementById('wt-add').addEventListener('click', () => {
  showCreateWorktreeDialog();
});

document.getElementById('wt-prune').addEventListener('click', () => {
  showDialog({
    title: 'Prune Worktrees',
    message: 'Remove stale worktree entries (worktrees whose directories no longer exist)?',
    confirmLabel: 'Prune',
    onConfirm: () => vscode.postMessage({ command: 'pruneWorktrees' }),
  });
});

function showCreateWorktreeDialog(startPoint) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.innerHTML = '<h3>Add Worktree</h3>'
    + '<p style="font-size:12px;margin-bottom:8px">Path for the new worktree directory:</p>'
    + '<input type="text" id="wt-dialog-path" placeholder="/path/to/worktree" style="width:100%;margin-bottom:8px" />'
    + '<p style="font-size:12px;margin-bottom:4px">Branch:</p>'
    + '<div style="display:flex;gap:8px;margin-bottom:6px">'
    + '<label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="radio" name="wt-branch-mode" value="existing" checked /> Existing branch</label>'
    + '<label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="radio" name="wt-branch-mode" value="new" /> New branch</label>'
    + '</div>'
    + '<input type="text" id="wt-dialog-branch" placeholder="Branch name" style="width:100%;margin-bottom:8px" />'
    + (startPoint ? '<input type="hidden" id="wt-dialog-start" value="' + escHtml(startPoint) + '" />' : '<input type="text" id="wt-dialog-start" placeholder="Start point (commit/branch, optional)" style="width:100%;margin-bottom:8px" />');

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.className = 'secondary';
  cancelBtn.addEventListener('click', () => overlay.remove());
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Create';
  confirmBtn.className = 'btn-primary';
  confirmBtn.addEventListener('click', () => {
    const path = dialog.querySelector('#wt-dialog-path').value.trim();
    if (!path) { showToast('Path is required', 'error'); return; }
    const branch = dialog.querySelector('#wt-dialog-branch').value.trim();
    const mode = dialog.querySelector('input[name="wt-branch-mode"]:checked').value;
    const sp = dialog.querySelector('#wt-dialog-start');
    const startPt = sp ? sp.value.trim() : '';
    const msg = { command: 'addWorktree', path };
    if (mode === 'new' && branch) { msg.newBranch = branch; }
    else if (branch) { msg.branch = branch; }
    if (startPt) msg.startPoint = startPt;
    vscode.postMessage(msg);
    overlay.remove();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  setTimeout(() => dialog.querySelector('#wt-dialog-path').focus(), 50);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
    if (e.key === 'Enter') confirmBtn.click();
  });
}

// --- Merge/rebase banner ---
function renderMergeBanner() {
  let banner = document.getElementById('merge-banner');
  if (!state.mergeState) {
    if (banner) banner.remove();
    return;
  }
  const ms = state.mergeState;
  const typeLabel = ms.type === 'cherry-pick' ? 'Cherry-pick' : ms.type.charAt(0).toUpperCase() + ms.type.slice(1);
  const progressText = ms.progress ? ' (' + ms.progress + ')' : '';
  const msgText = ms.message ? ' — ' + escHtml(ms.message) : '';

  let buttonsHtml = '';
  if (ms.type === 'rebase') {
    buttonsHtml = '<button class="btn-sm btn-continue" data-merge-action="rebaseContinue">Continue</button>'
      + '<button class="btn-sm" data-merge-action="rebaseSkip">Skip</button>'
      + '<button class="btn-sm btn-abort" data-merge-action="rebaseAbort">Abort</button>';
  } else if (ms.type === 'merge') {
    buttonsHtml = '<button class="btn-sm btn-abort" data-merge-action="mergeAbort">Abort</button>';
  } else if (ms.type === 'cherry-pick') {
    buttonsHtml = '<button class="btn-sm btn-continue" data-merge-action="cherryPickContinue">Continue</button>'
      + '<button class="btn-sm btn-abort" data-merge-action="cherryPickAbort">Abort</button>';
  }

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'merge-banner';
    banner.className = 'merge-banner';
    const toolbar = document.getElementById('toolbar');
    toolbar.parentNode.insertBefore(banner, toolbar.nextSibling);
  }
  banner.innerHTML = '<span class="banner-icon">⚠</span>'
    + '<span class="banner-text"><strong>' + typeLabel + ' in progress' + progressText + '</strong>' + msgText + '</span>'
    + '<div class="banner-actions">' + buttonsHtml + '</div>';

  banner.querySelectorAll('[data-merge-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.mergeAction;
      if (action.includes('Abort')) {
        showDialog({
          title: 'Abort ' + typeLabel,
          message: 'Abort the current ' + ms.type + '? Any resolved conflicts will be lost.',
          destructive: true,
          confirmLabel: 'Abort',
          onConfirm: () => gitAction(action, {}),
        });
      } else {
        gitAction(action, {});
      }
    });
  });
}

// --- Stash popover ---
const btnStash = document.getElementById('btn-stash');
const stashPopover = document.getElementById('stash-popover');

btnStash.addEventListener('click', (e) => {
  e.stopPropagation();
  const wasHidden = stashPopover.classList.contains('hidden');
  stashPopover.classList.toggle('hidden');
  if (wasHidden) vscode.postMessage({ command: 'requestStashes' });
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.stash-dropdown')) stashPopover.classList.add('hidden');
});

function renderStashList() {
  const listEl = document.getElementById('stash-list');
  const countEl = btnStash.querySelector('.stash-count');
  const stashes = state.stashes;
  if (countEl) {
    countEl.textContent = stashes.length;
    countEl.style.display = stashes.length > 0 ? '' : 'none';
  }
  if (!stashes.length) {
    listEl.innerHTML = '<div class="stash-empty">No stashes</div>';
    return;
  }
  listEl.innerHTML = stashes.map((s, i) => {
    const ref = 'stash@{' + s.index + '}';
    return '<div class="stash-item">'
      + '<div class="stash-item-info">'
      + '<div class="stash-item-ref">' + escHtml(ref) + '</div>'
      + '<div class="stash-item-msg" title="' + escHtml(s.message) + '">' + escHtml(s.message) + '</div>'
      + '</div>'
      + '<div class="stash-item-actions">'
      + '<button class="stash-apply btn-sm" data-idx="' + i + '" title="Apply (keep stash)">Apply</button>'
      + '<button class="stash-pop btn-sm" data-idx="' + i + '" title="Pop (apply & remove)">Pop</button>'
      + '<button class="stash-drop btn-sm" data-idx="' + i + '" title="Drop (delete)">Drop</button>'
      + '</div>'
      + '</div>';
  }).join('');

  listEl.querySelectorAll('.stash-apply').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = state.stashes[parseInt(btn.dataset.idx)];
      if (s) gitAction('stashApply', { stashRef: 'stash@{' + s.index + '}' });
    });
  });
  listEl.querySelectorAll('.stash-pop').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = state.stashes[parseInt(btn.dataset.idx)];
      if (s) gitAction('stashPop', { stashRef: 'stash@{' + s.index + '}' });
    });
  });
  listEl.querySelectorAll('.stash-drop').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = state.stashes[parseInt(btn.dataset.idx)];
      if (!s) return;
      showDialog({
        title: 'Drop Stash',
        message: 'Delete stash@{' + s.index + '}? This cannot be undone.',
        destructive: true,
        confirmLabel: 'Drop',
        onConfirm: () => gitAction('stashDrop', { stashRef: 'stash@{' + s.index + '}' }),
      });
    });
  });
}

document.getElementById('stash-save').addEventListener('click', () => {
  showDialog({
    title: 'Stash Changes',
    input: { placeholder: 'Stash message (optional)' },
    confirmLabel: 'Stash',
    onConfirm: (msg) => gitAction('stashSave', msg ? { message: msg } : {}),
  });
});

// --- Graph column resize ---
{
  const resizeHandle = document.getElementById('graph-resize-handle');
  let resizing = false, startX = 0, startW = 0;
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizing = true;
    startX = e.clientX;
    startW = document.querySelector('.col-graph').offsetWidth;
    resizeHandle.classList.add('dragging');
    resizeHandle.setPointerCapture(e.pointerId);
  });
  resizeHandle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const newW = Math.max(40, Math.min(400, startW + e.clientX - startX));
    document.documentElement.style.setProperty('--graph-col-w', newW + 'px');
  });
  resizeHandle.addEventListener('pointerup', (e) => {
    if (!resizing) return;
    resizing = false;
    resizeHandle.classList.remove('dragging');
    const newW = Math.max(40, Math.min(400, startW + e.clientX - startX));
    state.graphColWidth = newW;
    document.documentElement.style.setProperty('--graph-col-w', newW + 'px');
  });
  resizeHandle.addEventListener('dblclick', () => {
    state.graphColWidth = null;
    graphRender(-1);
  });
}

// --- Graph rendering (faithful port of vscode-git-graph graph.ts) ---

class GBranch {
  constructor(colour, isStash) {
    this._colour = colour;
    this._isStash = !!isStash;
    this._end = 0;
    this._lines = [];
    this._numUncommitted = 0;
  }
  addLine(p1, p2, isCommitted, lockedFirst) {
    this._lines.push({ p1, p2, lockedFirst });
    if (isCommitted) {
      if (p2.x === 0 && p2.y < this._numUncommitted) this._numUncommitted = p2.y;
    } else {
      this._numUncommitted++;
    }
  }
  getColour() { return this._colour; }
  getEnd() { return this._end; }
  setEnd(end) { this._end = end; }

  draw(svg, config, expandAt) {
    const colour = this._isStash ? '#808080' : config.colours[this._colour % config.colours.length];
    const d = config.grid.y * (config.style === 'angular' ? 0.38 : 0.8);
    const pxLines = [];
    let curPath = '';

    for (let i = 0; i < this._lines.length; i++) {
      const ln = this._lines[i];
      let x1 = ln.p1.x * config.grid.x + config.grid.offsetX;
      let y1 = ln.p1.y * config.grid.y + config.grid.offsetY;
      let x2 = ln.p2.x * config.grid.x + config.grid.offsetX;
      let y2 = ln.p2.y * config.grid.y + config.grid.offsetY;

      if (expandAt > -1) {
        if (ln.p1.y > expandAt) {
          y1 += config.grid.expandY; y2 += config.grid.expandY;
        } else if (ln.p2.y > expandAt) {
          if (x1 === x2) {
            y2 += config.grid.expandY;
          } else if (ln.lockedFirst) {
            pxLines.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isC: i >= this._numUncommitted, lf: ln.lockedFirst });
            pxLines.push({ p1: { x: x2, y: y1 + config.grid.y }, p2: { x: x2, y: y2 + config.grid.expandY }, isC: i >= this._numUncommitted, lf: ln.lockedFirst });
            continue;
          } else {
            pxLines.push({ p1: { x: x1, y: y1 }, p2: { x: x1, y: y2 - config.grid.y + config.grid.expandY }, isC: i >= this._numUncommitted, lf: ln.lockedFirst });
            y1 += config.grid.expandY; y2 += config.grid.expandY;
          }
        }
      }
      pxLines.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isC: i >= this._numUncommitted, lf: ln.lockedFirst });
    }

    // Simplify consecutive vertical segments
    let si = 0;
    while (si < pxLines.length - 1) {
      const a = pxLines[si], b = pxLines[si + 1];
      if (a.p1.x === a.p2.x && a.p2.x === b.p1.x && b.p1.x === b.p2.x && a.p2.y === b.p1.y && a.isC === b.isC) {
        a.p2.y = b.p2.y;
        pxLines.splice(si + 1, 1);
      } else { si++; }
    }

    // Build SVG paths
    for (let i = 0; i < pxLines.length; i++) {
      const pl = pxLines[i];
      const x1 = pl.p1.x, y1 = pl.p1.y, x2 = pl.p2.x, y2 = pl.p2.y;

      if (curPath !== '' && i > 0 && pl.isC !== pxLines[i - 1].isC) {
        GBranch._drawPath(svg, curPath, pxLines[i - 1].isC, colour);
        curPath = '';
      }
      if (curPath === '' || (i > 0 && (x1 !== pxLines[i - 1].p2.x || y1 !== pxLines[i - 1].p2.y))) {
        curPath += 'M' + x1.toFixed(0) + ',' + y1.toFixed(1);
      }
      if (x1 === x2) {
        curPath += 'L' + x2.toFixed(0) + ',' + y2.toFixed(1);
      } else if (config.style === 'angular') {
        curPath += 'L' + (pl.lf ? (x2.toFixed(0) + ',' + (y2 - d).toFixed(1)) : (x1.toFixed(0) + ',' + (y1 + d).toFixed(1))) + 'L' + x2.toFixed(0) + ',' + y2.toFixed(1);
      } else {
        curPath += 'C' + x1.toFixed(0) + ',' + (y1 + d).toFixed(1) + ' ' + x2.toFixed(0) + ',' + (y2 - d).toFixed(1) + ' ' + x2.toFixed(0) + ',' + y2.toFixed(1);
      }
    }
    if (curPath !== '') GBranch._drawPath(svg, curPath, pxLines[pxLines.length - 1].isC, colour);
  }

  static _drawPath(svg, path, isCommitted, colour) {
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('class', 'line');
    line.setAttribute('d', path);
    line.setAttribute('stroke', isCommitted ? colour : '#808080');
    if (!isCommitted) line.setAttribute('stroke-dasharray', '2');
    svg.appendChild(line);
  }
}

class GVertex {
  constructor(id, isStash, author) {
    this.id = id;
    this.isStash = isStash;
    /** {name, email} of the commit's author, or null for a row that has none. */
    this._author = author || null;
    this._x = 0;
    this._children = [];
    this._parents = [];
    this._nextParent = 0;
    this._onBranch = null;
    this._isCommitted = true;
    this._isCurrent = false;
    this._nextX = 0;
    this._connections = [];
  }
  addChild(v) { this._children.push(v); }
  getChildren() { return this._children; }
  addParent(v) { this._parents.push(v); }
  getParents() { return this._parents; }
  hasParents() { return this._parents.length > 0; }
  getNextParent() { return this._nextParent < this._parents.length ? this._parents[this._nextParent] : null; }
  registerParentProcessed() { this._nextParent++; }
  isMerge() { return this._parents.length > 1; }

  addToBranch(branch, x) { if (this._onBranch === null) { this._onBranch = branch; this._x = x; } }
  isNotOnBranch() { return this._onBranch === null; }
  isOnThisBranch(branch) { return this._onBranch === branch; }
  getBranch() { return this._onBranch; }

  getPoint() { return { x: this._x, y: this.id }; }
  getNextPoint() { return { x: this._nextX, y: this.id }; }

  getPointConnectingTo(vertex, onBranch) {
    for (let i = 0; i < this._connections.length; i++) {
      if (this._connections[i].connectsTo === vertex && this._connections[i].onBranch === onBranch) return { x: i, y: this.id };
    }
    return null;
  }
  registerUnavailablePoint(x, connectsTo, onBranch) {
    if (x === this._nextX) { this._nextX = x + 1; this._connections[x] = { connectsTo, onBranch }; }
  }

  getColour() { return this._onBranch !== null ? this._onBranch.getColour() : 0; }
  getIsCommitted() { return this._isCommitted; }
  setNotCommitted() { this._isCommitted = false; }
  setCurrent() { this._isCurrent = true; }

  /*
   * The node is the author's avatar, ringed in the lane's colour — which is
   * what makes a graph readable as *who* rather than as a column of identical
   * dots. Initials, never a fetched image: an avatar service would mean handing
   * every committer's email address to a third party, which a self-hosted tool
   * must not do quietly.
   *
   * Rows with no author — uncommitted changes, a stash — keep a plain dot,
   * because inventing initials for them would be a lie.
   */
  draw(svg, config, expandOffset, overListener, outListener) {
    if (this._onBranch === null) return;
    const STASH_COLOR = '#808080';
    const colour = this.isStash ? STASH_COLOR
      : this._isCommitted ? config.colours[this._onBranch.getColour() % config.colours.length] : '#808080';
    const cx = (this._x * config.grid.x + config.grid.offsetX).toString();
    const cy = (this.id * config.grid.y + config.grid.offsetY + (expandOffset ? config.grid.expandY : 0)).toString();
    const named = this._isCommitted && !this.isStash && !!this._author && !!this._author.name;
    const r = named ? (config.nodeR || 9) : 4.5;

    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.dataset.id = this.id.toString();
    circle.dataset.r = r.toString();
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', r.toString());
    circle.setAttribute('stroke', colour);
    circle.setAttribute('stroke-width', named ? '2' : '0');
    circle.setAttribute('fill', named ? authorColor(this._author.email || this._author.name) : colour);
    if (this._isCurrent) circle.setAttribute('class', 'graphCurrent');
    svg.appendChild(circle);

    if (named) {
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'node-initials');
      label.setAttribute('x', cx);
      label.setAttribute('y', cy);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.textContent = authorInitials(this._author.name);
      svg.appendChild(label);
    }

    circle.addEventListener('mouseover', overListener);
    circle.addEventListener('mouseout', outListener);
  }
}

// --- Graph layout state ---
let gVertices = [], gBranches = [], gAvailColours = [], gCommitLookup = {};

function graphLoadCommits(commits) {
  gVertices = []; gBranches = []; gAvailColours = [];
  if (commits.length === 0) return;

  const nullVertex = new GVertex(NULL_VERTEX_ID, false);
  const lookup = {};
  for (let i = 0; i < commits.length; i++) {
    lookup[commits[i].hash] = i;
    gVertices.push(new GVertex(i, !!commits[i]._isStash, { name: commits[i].author, email: commits[i].authorEmail }));
  }
  gCommitLookup = lookup;

  for (let i = 0; i < commits.length; i++) {
    for (let j = 0; j < commits[i].parents.length; j++) {
      const ph = commits[i].parents[j];
      if (typeof lookup[ph] === 'number') {
        gVertices[i].addParent(gVertices[lookup[ph]]);
        gVertices[lookup[ph]].addChild(gVertices[i]);
      } else {
        gVertices[i].addParent(nullVertex);
      }
    }
  }

  if (state.head && typeof lookup[state.head] === 'number') {
    gVertices[lookup[state.head]].setCurrent();
  }

  let i = 0;
  while (i < gVertices.length) {
    if (gVertices[i].getNextParent() !== null || gVertices[i].isNotOnBranch()) {
      graphDeterminePath(i);
    } else { i++; }
  }
}

function graphDeterminePath(startAt) {
  let i = startAt;
  let vertex = gVertices[i], parentVertex = gVertices[i].getNextParent(), curVertex;
  let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint(), curPoint;

  if (parentVertex !== null && parentVertex.id !== NULL_VERTEX_ID && vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
    let foundPtp = false, pBranch = parentVertex.getBranch();
    for (i = startAt + 1; i < gVertices.length; i++) {
      curVertex = gVertices[i];
      curPoint = curVertex.getPointConnectingTo(parentVertex, pBranch);
      if (curPoint !== null) { foundPtp = true; } else { curPoint = curVertex.getNextPoint(); }
      pBranch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), !foundPtp && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true);
      curVertex.registerUnavailablePoint(curPoint.x, parentVertex, pBranch);
      lastPoint = curPoint;
      if (foundPtp) { vertex.registerParentProcessed(); break; }
    }
  } else {
    const branch = new GBranch(graphGetAvailableColour(startAt), vertex.isStash);
    vertex.addToBranch(branch, lastPoint.x);
    vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);
    for (i = startAt + 1; i < gVertices.length; i++) {
      curVertex = gVertices[i];
      curPoint = parentVertex === curVertex && !parentVertex.isNotOnBranch() ? curVertex.getPoint() : curVertex.getNextPoint();
      branch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), lastPoint.x < curPoint.x);
      curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
      lastPoint = curPoint;
      if (parentVertex === curVertex) {
        vertex.registerParentProcessed();
        const onBranch = !parentVertex.isNotOnBranch();
        parentVertex.addToBranch(branch, curPoint.x);
        vertex = parentVertex;
        parentVertex = vertex.getNextParent();
        if (parentVertex === null || onBranch) break;
      }
    }
    if (i === gVertices.length && parentVertex !== null && parentVertex.id === NULL_VERTEX_ID) {
      vertex.registerParentProcessed();
    }
    branch.setEnd(i);
    gBranches.push(branch);
    gAvailColours[branch.getColour()] = i;
  }
}

function graphGetAvailableColour(startAt) {
  for (let i = 0; i < gAvailColours.length; i++) {
    if (startAt > gAvailColours[i]) return i;
  }
  gAvailColours.push(0);
  return gAvailColours.length - 1;
}

function graphRender(expandIdx) {
  const container = document.getElementById('graph-svg-container');
  container.innerHTML = '';
  if (gVertices.length === 0) { if (state.graphColWidth === null) document.documentElement.style.setProperty('--graph-col-w', '40px'); return; }

  // Measure actual row height (may be fractional due to browser zoom)
  // and use it for SVG grid to prevent cumulative sub-pixel drift
  const firstRow = document.querySelector('#commit-list .commit-row');
  const rowH = firstRow ? firstRow.getBoundingClientRect().height : graphConfig.grid.y;
  const cfg = { ...graphConfig, grid: { ...graphConfig.grid, y: rowH, offsetY: rowH / 2 } };

  const svg = document.createElementNS(SVG_NS, 'svg');
  const group = document.createElementNS(SVG_NS, 'g');

  for (let i = 0; i < gBranches.length; i++) gBranches[i].draw(group, cfg, expandIdx);

  const overL = (e) => graphVertexOver(e), outL = (e) => graphVertexOut(e);
  for (let i = 0; i < gVertices.length; i++) {
    gVertices[i].draw(group, cfg, expandIdx > -1 && i > expandIdx, overL, outL);
  }

  svg.appendChild(group);

  let maxX = 0;
  for (let i = 0; i < gVertices.length; i++) {
    const p = gVertices[i].getNextPoint();
    if (p.x > maxX) maxX = p.x;
  }
  const w = 2 * cfg.grid.offsetX + Math.max(maxX - 1, 0) * cfg.grid.x;
  const h = gVertices.length * cfg.grid.y + cfg.grid.offsetY - cfg.grid.y / 2 + (expandIdx > -1 ? cfg.grid.expandY : 0);

  const gw = Math.max(w, 40);
  svg.setAttribute('width', gw.toString());
  svg.setAttribute('height', h.toString());
  container.appendChild(svg);
  if (state.graphColWidth === null) document.documentElement.style.setProperty('--graph-col-w', gw + 'px');
}

function graphVertexOver(e) {
  if (!e.target || !e.target.dataset || !e.target.dataset.id) return;
  const id = parseInt(e.target.dataset.id);
  if (id >= 0 && id < gVertices.length) {
    const rows = document.querySelectorAll('.commit-row:not(.header-row)');
    if (rows[id]) rows[id].classList.add('graph-hover');
    e.target.setAttribute('r', (Number(e.target.dataset.r || 4.5) + 1.5).toString());
  }
}
function graphVertexOut(e) {
  if (!e.target || !e.target.dataset || !e.target.dataset.id) return;
  const id = parseInt(e.target.dataset.id);
  if (id >= 0) {
    const rows = document.querySelectorAll('.commit-row:not(.header-row)');
    if (rows[id]) rows[id].classList.remove('graph-hover');
    e.target.setAttribute('r', (e.target.dataset.r || '4.5'));
  }
}

// --- Commit list ---
function getDisplayCommits() {
  let commits = state.commits;

  // Inject uncommitted changes virtual commit
  const u = state.uncommitted;
  const totalFiles = u ? (u.staged.length + u.unstaged.length + (u.conflicted ? u.conflicted.length : 0)) : 0;
  if (u && totalFiles > 0) {
    commits = [{
      hash: 'uncommitted',
      parents: state.head ? [state.head] : [],
      author: '', authorEmail: '',
      authorDate: Math.floor(Date.now() / 1000),
      committer: '', committerEmail: '',
      commitDate: Math.floor(Date.now() / 1000),
      refs: [],
      message: 'Uncommitted Changes (' + totalFiles + ' files)',
    }, ...commits];
  }

  // Inject stash virtual commits as branch spurs from their parent
  if (state.settings.showStashes && state.stashes.length > 0) {
    const parentIndexes = {};
    const commitHashSet = new Set(commits.map(c => c.hash));
    for (const s of state.stashes) {
      if (!s.parentHash || !commitHashSet.has(s.parentHash)) continue;
      if (!parentIndexes[s.parentHash]) parentIndexes[s.parentHash] = [];
      parentIndexes[s.parentHash].push(s);
    }
    if (Object.keys(parentIndexes).length > 0) {
      const result = [];
      for (const c of commits) {
        // Stash virtual commits must come BEFORE their parent in the array
        // (graph algorithm scans forward to find parents — same pattern as uncommitted)
        const stashesForCommit = parentIndexes[c.hash];
        if (stashesForCommit) {
          for (const s of stashesForCommit) {
            result.push({
              hash: s.hash,
              parents: [s.parentHash],
              author: '', authorEmail: '',
              authorDate: 0, committer: '', committerEmail: '', commitDate: 0,
              refs: [{ type: 'stash', name: 'stash@{' + s.index + '}' }],
              message: s.message,
              _isStash: true,
            });
          }
        }
        result.push(c);
      }
      commits = result;
    }
  }

  return commits;
}

/*
 * Below this width the row carries the graph and the message only, with the
 * author, date and hash on a second line under the subject: six columns of
 * fragments on a phone is not a list of commits, and PPM's layout rules ask for
 * one column there. The value matches the max-width:640px block in the CSS —
 * both have to agree, because the JS decides where the ref badges are put and
 * the CSS decides which columns exist.
 */
function isNarrowLayout() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
}

function renderCommitList() {
  const container = document.getElementById('commit-list');
  container.innerHTML = '';

  const displayCommits = getDisplayCommits();
  graphLoadCommits(displayCommits);

  // Mark uncommitted vertex for dashed lines
  if (displayCommits.length > 0 && displayCommits[0].hash === 'uncommitted') {
    if (gVertices.length > 0) gVertices[0].setNotCommitted();
  }

  displayCommits.forEach((commit, idx) => {
    const isVirtual = commit.hash === 'uncommitted';
    const isStash = !!commit._isStash;
    const row = document.createElement('div');
    row.className = 'commit-row' + (isVirtual ? ' virtual' : '') + (isStash ? ' stash-row' : '');
    row.dataset.hash = commit.hash;

    // Branch / tag column. Below 640px there is no room for it, so the badges
    // go inline ahead of the subject instead — one home or the other, never
    // both, or the second copy's context menu would act on a hidden badge.
    const narrow = isNarrowLayout();
    const refsCol = document.createElement('div');
    refsCol.className = 'col-refs';

    // Graph spacer column (SVG overlays this area)
    const graphCol = document.createElement('div');
    graphCol.className = 'col-graph';

    const msgCol = document.createElement('div');
    msgCol.className = 'col-message';
    let badges = '';
    if (commit.refs) {
      // Known remote prefixes from repo info (e.g. "origin/", "upstream/")
      const remotePrefixes = state.remotes.map(r => r.name + '/');
      // Re-classify refs using known remotes (parser may misclassify local branches with "/" as remote)
      const classified = commit.refs.map(ref => {
        if (ref.type === 'head' || ref.type === 'tag' || ref.type === 'stash') return ref;
        const isActualRemote = remotePrefixes.some(p => ref.name.startsWith(p));
        return { ...ref, type: isActualRemote ? 'remote' : 'local' };
      });
      // Merge remote+local: if origin/X and X both exist, show one synced badge
      const localNames = new Set(classified.filter(r => r.type === 'head' || r.type === 'local').map(r => r.name));
      const mergedRemotes = new Set();
      classified.forEach(ref => {
        if (ref.type === 'remote') {
          const prefix = remotePrefixes.find(p => ref.name.startsWith(p));
          const branchName = prefix ? ref.name.slice(prefix.length) : ref.name;
          if (localNames.has(branchName)) {
            mergedRemotes.add(ref.name);
          }
        }
      });
      classified.forEach(ref => {
        if (ref.type === 'tag' && !state.settings.showTags) return;
        if (ref.type === 'remote' && !state.settings.showRemoteBranches) return;
        if (mergedRemotes.has(ref.name)) return;
        const isSynced = (ref.type === 'head' || ref.type === 'local') &&
          classified.some(r => r.type === 'remote' && remotePrefixes.some(p => r.name === p + ref.name));
        const syncIcon = isSynced ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg> ' : '';
        badges += '<span class="ref-badge ref-' + ref.type + '" data-ref="' + escHtml(ref.name) + '">' + syncIcon + escHtml(ref.name) + '</span>';
      });
    }
    if (!narrow) refsCol.innerHTML = badges;
    const meta = isVirtual || isStash ? ''
      : '<span class="msg-meta">' + escHtml(commit.author) + ' \u00b7 '
        + escHtml(formatDate(commit.commitDate)) + ' \u00b7 ' + escHtml(commit.hash.substring(0, 7))
        + '</span>';
    msgCol.innerHTML = '<span class="msg-subject">' + (narrow ? badges : '')
      + formatCommitMessage(commit.message) + '</span>' + meta;

    // The lane's colour, for the tick at the start of the message.
    const vertex = gVertices[idx];
    if (vertex && !isVirtual && !isStash) {
      row.style.setProperty('--lane', GRAPH_COLORS[vertex.getColour() % GRAPH_COLORS.length]);
    }

    // Attach context menu and double-click to ref badges
    row.appendChild(refsCol);
    row.querySelectorAll('.ref-badge').forEach(badge => {
      const refName = badge.dataset.ref || badge.textContent.trim();
      const refType = badge.className.includes('ref-head') ? 'head'
                    : badge.className.includes('ref-remote') ? 'remote'
                    : badge.className.includes('ref-tag') ? 'tag'
                    : badge.className.includes('ref-stash') ? 'stash' : 'local';
      badge.style.cursor = 'pointer';
      makeRefDraggable(badge, refName, refType);
      if (refType === 'stash') {
        badge.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showStashBadgeMenu(e.clientX, e.clientY, refName);
        });
      } else {
        badge.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          gitAction('checkout', { target: refName });
        });
        badge.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showBranchContextMenu(e.clientX, e.clientY, refName, refType, commit);
        });
      }
    });

    const changesCol = document.createElement('div');
    changesCol.className = 'col-changes';
    if (!isVirtual && !isStash) fillChangesCell(changesCol, state.stats[commit.hash]);

    const authorCol = document.createElement('div');
    authorCol.className = 'col-author';
    if (isVirtual || isStash) {
      authorCol.textContent = '';
    } else {
      // No avatar here any more — it is the graph node now, and twice on one
      // row was noise.
      authorCol.textContent = commit.author;
      authorCol.addEventListener('mouseenter', () => showAuthorCard(authorCol, commit));
      authorCol.addEventListener('mouseleave', hideAuthorCard);
    }

    const dateCol = document.createElement('div');
    dateCol.className = 'col-date';
    dateCol.textContent = isVirtual ? 'now' : isStash ? '' : formatDate(commit.commitDate);
    // The column is relative by default, so the exact moment goes in the title
    // rather than in a wider column.
    if (!isVirtual && !isStash) dateCol.title = new Date(commit.commitDate * 1000).toLocaleString();

    const hashCol = document.createElement('div');
    hashCol.className = 'col-hash';
    hashCol.textContent = isVirtual ? '...' : isStash ? '' : commit.hash.substring(0, 7);

    row.appendChild(graphCol);
    row.appendChild(msgCol);
    row.appendChild(changesCol);
    row.appendChild(authorCol);
    row.appendChild(dateCol);
    row.appendChild(hashCol);

    makeRowDropTarget(row, commit);
    row.addEventListener('click', () => selectCommit(commit.hash));
    if (isVirtual) {
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showUncommittedContextMenu(e.clientX, e.clientY);
      });
      setupLongPress(row, (x, y) => showUncommittedContextMenu(x, y));
    } else if (isStash) {
      const stashRef = (commit.refs && commit.refs[0]) ? commit.refs[0].name : '';
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (stashRef) showStashBadgeMenu(e.clientX, e.clientY, stashRef);
      });
      setupLongPress(row, (x, y) => { if (stashRef) showStashBadgeMenu(x, y, stashRef); });
    } else {
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCommitContextMenu(e.clientX, e.clientY, commit);
      });
      setupLongPress(row, (x, y) => showCommitContextMenu(x, y, commit));
    }

    container.appendChild(row);
  });

  graphRender(-1);
  renderScrollMarkers();
}

/*
 * A merge commit has no diffstat — that is git's default, not a failure — so an
 * absent entry leaves the cell empty rather than claiming it changed nothing.
 */
function fillChangesCell(cell, stat) {
  cell.textContent = '';
  if (!stat) return;
  if (stat.insertions > 0) {
    const add = document.createElement('span');
    add.className = 'ch-add';
    add.textContent = '+' + stat.insertions;
    cell.appendChild(add);
  }
  if (stat.deletions > 0) {
    const del = document.createElement('span');
    del.className = 'ch-del';
    del.textContent = '-' + stat.deletions;
    cell.appendChild(del);
  }
  cell.title = stat.files + (stat.files === 1 ? ' file changed' : ' files changed');
}

/** Fill the column in place: the rows are already drawn, and rebuilding them
 *  would throw away the scroll position and the open detail panel. */
function applyCommitStats() {
  document.querySelectorAll('#commit-list .commit-row').forEach((row) => {
    const cell = row.querySelector('.col-changes');
    const hash = row.dataset.hash;
    if (cell && hash && hash !== 'uncommitted') fillChangesCell(cell, state.stats[hash]);
  });
}

/*
 * One tick per interesting row, positioned by its index in the whole loaded
 * history rather than by pixels — the rows are a uniform height, so the two
 * agree, and an index needs no measuring and survives a resize.
 *
 * Search matches are drawn first so that the checked-out and selected ticks sit
 * on top of them when they land on the same row.
 */
function renderScrollMarkers() {
  const host = document.getElementById('scroll-markers');
  if (!host) return;
  host.innerHTML = '';
  const commits = getDisplayCommits();
  if (commits.length === 0) return;

  const mark = (idx, kind) => {
    const el = document.createElement('div');
    el.className = 'scroll-marker sm-' + kind;
    el.style.top = ((idx + 0.5) / commits.length * 100) + '%';
    host.appendChild(el);
  };

  for (let i = 0; i < state.searchMatches.length; i++) mark(state.searchMatches[i], 'search');
  for (let i = 0; i < commits.length; i++) {
    if (commits[i].hash === state.head) mark(i, 'head');
    if (commits[i].hash === state.selectedCommit) mark(i, 'selected');
  }
}

function selectCommit(hash) {
  // Deselect previous
  document.querySelectorAll('.commit-row.selected').forEach(el => el.classList.remove('selected'));

  if (state.selectedCommit === hash) {
    state.selectedCommit = null;
    state.expandedCommit = null;
    document.getElementById('detail-panel').classList.add('hidden');
    renderScrollMarkers();
    return;
  }

  state.selectedCommit = hash;
  state.expandedCommit = hash;
  const row = document.querySelector('[data-hash="' + CSS.escape(hash) + '"]');
  if (row) row.classList.add('selected');
  renderScrollMarkers();

  if (hash === 'uncommitted') {
    renderUncommittedDetail();
    return;
  }
  vscode.postMessage({ command: 'requestCommitDetails', hash });
}

// --- File tree helpers ---
function buildFileTree(files) {
  const root = { name: '', children: {}, files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children[parts[i]]) node.children[parts[i]] = { name: parts[i], children: {}, files: [] };
      node = node.children[parts[i]];
    }
    node.files.push({ ...f, fileName: parts[parts.length - 1] });
  }
  return root;
}

function countFiles(node) {
  let count = node.files.length;
  for (const child of Object.values(node.children)) count += countFiles(child);
  return count;
}

function renderFileTree(node, depth, hash, parentHash, section) {
  let html = '';
  const dirs = Object.keys(node.children).sort();
  for (const dir of dirs) {
    const child = node.children[dir];
    html += '<div class="tree-dir" style="padding-left:' + (depth * 16) + 'px">';
    html += ICONS.folderOpen + ' <span class="tree-dir-name">' + escHtml(dir) + '/</span>';
    html += '<span class="tree-dir-count">(' + countFiles(child) + ')</span></div>';
    html += renderFileTree(child, depth + 1, hash, parentHash, section);
  }
  const sortedFiles = [...node.files].sort((a, b) => a.fileName.localeCompare(b.fileName));
  for (const f of sortedFiles) {
    html += '<div class="file-item file-clickable" style="padding-left:' + (depth * 16) + 'px" ';
    html += 'data-path="' + escHtml(f.path) + '" data-hash="' + escHtml(hash) + '" data-parent="' + escHtml(parentHash) + '">';
    html += '<span class="file-status file-status-' + escHtml(f.status) + '">' + escHtml(f.status) + '</span>';
    html += '<span class="file-name">' + escHtml(f.fileName) + '</span>';
    if (f.additions > 0 || f.deletions > 0) {
      html += '<span class="file-stat">';
      if (f.additions > 0) html += '<span class="add">+' + f.additions + '</span> ';
      if (f.deletions > 0) html += '<span class="del">-' + f.deletions + '</span>';
      html += '</span>';
    }
    if (section) html += renderFileActions(f, section);
    html += '</div>';
  }
  return html;
}

/* Split so the file name can be shown before the directory it sits in: the
   list lives in a narrow column, and truncating from the end has to eat the
   path, not the name. */
function basename(path) {
  const i = String(path).lastIndexOf('/');
  return i === -1 ? String(path) : String(path).slice(i + 1);
}
function dirname(path) {
  const i = String(path).lastIndexOf('/');
  return i === -1 ? '' : String(path).slice(0, i);
}

function renderFileListHtml(files, hash, parentHash, section) {
  if (state.fileViewMode === 'tree') {
    return renderFileTree(buildFileTree(files), 0, hash, parentHash, section);
  }
  return files.map(f =>
    '<div class="file-item file-clickable" title="' + escHtml(f.path) + '" data-path="' + escHtml(f.path) + '" data-hash="' + escHtml(hash) + '" data-parent="' + escHtml(parentHash || '') + '">' +
      '<span class="file-status file-status-' + escHtml(f.status) + '">' + escHtml(f.status) + '</span>' +
      '<span class="file-name">' + escHtml(basename(f.path)) + '</span>' +
      (dirname(f.path) ? '<span class="file-dir">' + escHtml(dirname(f.path)) + '</span>' : '') +
      '<span class="file-stat">' +
        (f.additions > 0 ? '<span class="add">+' + f.additions + '</span> ' : '') +
        (f.deletions > 0 ? '<span class="del">-' + f.deletions + '</span>' : '') +
      '</span>' +
      (section ? renderFileActions(f, section) : '') +
    '</div>'
  ).join('');
}

function renderFileActions(file, section) {
  let html = '<span class="file-actions">';
  if (section === 'unstaged') {
    html += '<button class="file-action-btn" data-action="stage" data-file="' + escHtml(file.path) + '" title="Stage">' + ICONS.plus + '</button>';
    html += '<button class="file-action-btn" data-action="discard" data-file="' + escHtml(file.path) + '" title="Discard changes">' + ICONS.x + '</button>';
  } else if (section === 'staged') {
    html += '<button class="file-action-btn" data-action="unstage" data-file="' + escHtml(file.path) + '" title="Unstage">' + ICONS.minus + '</button>';
  }
  html += '<button class="file-action-btn" data-action="open" data-file="' + escHtml(file.path) + '" title="Open file">' + ICONS.fileOpen + '</button>';
  html += '</span>';
  return html;
}

function fileViewToggleHtml() {
  return '<div class="file-view-toggle">' +
    '<button class="toggle-btn' + (state.fileViewMode === 'list' ? ' active' : '') + '" data-view="list" title="List view">' + ICONS.list + '</button>' +
    '<button class="toggle-btn' + (state.fileViewMode === 'tree' ? ' active' : '') + '" data-view="tree" title="Tree view">' + ICONS.tree + '</button>' +
  '</div>';
}

function renderUncommittedDetail() {
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');
  panel.classList.remove('split');
  const u = state.uncommitted;
  if (!u) { panel.classList.add('hidden'); return; }
  let html = '<div class="detail-pad"><h3>Uncommitted Changes</h3>';
  const hasFiles = u.staged.length > 0 || u.unstaged.length > 0 || (u.conflicted && u.conflicted.length > 0);
  if (hasFiles) {
    html += fileViewToggleHtml();
  }
  // Conflict section (above staged/unstaged)
  if (u.conflicted && u.conflicted.length > 0) {
    html += '<div class="file-list"><div class="conflict-header">⚠ Conflicts (' + u.conflicted.length + ')</div>';
    html += u.conflicted.map(f => {
      const fileName = f.path.split('/').pop() || f.path;
      return '<div class="file-item">'
        + '<span class="file-status file-status-U">U</span>'
        + '<span class="file-clickable" data-file="' + escHtml(f.path) + '" data-hash="uncommitted" data-parent="' + escHtml(state.head) + '">' + escHtml(f.path) + '</span>'
        + '<div class="file-actions">'
        + '<button class="file-action-btn" data-action="open-conflict" data-file="' + escHtml(f.path) + '" title="Open conflict file">' + ICONS.fileOpen + '</button>'
        + '<button class="file-action-btn" data-action="stage" data-file="' + escHtml(f.path) + '" title="Mark resolved (stage)">' + ICONS.plus + '</button>'
        + '</div></div>';
    }).join('');
    html += '</div>';
  }
  if (u.staged.length > 0) {
    html += '<div class="file-list"><div class="section-actions"><strong>Staged (' + u.staged.length + '):</strong>';
    html += '<button class="btn-sm section-action-btn" data-action="unstage-all">Unstage All</button></div>';
    html += renderFileListHtml(u.staged, 'staged', state.head, 'staged');
    html += '</div>';
  }
  if (u.unstaged.length > 0) {
    html += '<div class="file-list"><div class="section-actions"><strong>Unstaged (' + u.unstaged.length + '):</strong>';
    html += '<button class="btn-sm section-action-btn" data-action="stage-all">Stage All</button></div>';
    html += renderFileListHtml(u.unstaged, 'uncommitted', state.head, 'unstaged');
    html += '</div>';
  }
  if (u.staged.length === 0 && u.unstaged.length === 0 && (!u.conflicted || u.conflicted.length === 0)) {
    html += '<p>No uncommitted changes.</p>';
  }
  html += '<div class="commit-section">';
  html += '<textarea id="commit-message" placeholder="Commit message..." rows="3"></textarea>';
  html += '<div class="commit-actions"><button id="btn-commit" class="btn-sm btn-commit" disabled>Commit</button></div>';
  html += '</div></div>';
  panel.innerHTML = html;
  wireCommitControls();
}

function wireCommitControls() {
  const textarea = document.getElementById('commit-message');
  const commitBtn = document.getElementById('btn-commit');
  if (!textarea || !commitBtn) return;
  const updateBtn = () => {
    const hasMsg = textarea.value.trim().length > 0;
    const hasStaged = state.uncommitted && state.uncommitted.staged.length > 0;
    commitBtn.disabled = !(hasMsg && hasStaged);
  };
  textarea.addEventListener('input', updateBtn);
  updateBtn();
  commitBtn.addEventListener('click', () => {
    const message = textarea.value.trim();
    if (!message) return;
    vscode.postMessage({ command: 'gitAction', action: 'commit', args: { message } });
    textarea.value = '';
    commitBtn.disabled = true;
  });
}

// --- Detail panel ---

/* A value you can read in full and click to copy. Anything with a data-copy
   attribute is handled by the panel's one click delegate. */
function copyable(inner, text, cls) {
  return '<span class="meta-value ' + cls + '" data-copy="' + escHtml(text)
    + '" title="Click to copy">' + inner + '</span>';
}

/* Forty hex characters in one run is not text anyone reads. The eight that
   identify the commit carry the contrast and the other thirty-two go quiet —
   the whole thing is still there, and still what a click copies. */
function hashCell(hash) {
  const lead = String(hash).slice(0, 8);
  const tail = String(hash).slice(8);
  return copyable('<span class="hash-lead">' + escHtml(lead) + '</span>' + escHtml(tail), hash, 'mono');
}

/* Name and email are two things, so they are told apart by weight rather than
   by angle brackets. What a click copies is still the canonical form, which is
   what git itself wants back. */
function personCell(name, email) {
  return copyable(
    '<span class="meta-name">' + escHtml(name) + '</span><span class="meta-email">' + escHtml(email) + '</span>',
    name + ' <' + email + '>',
    'person',
  );
}

/* The timezone is part of the answer: a commit stamped 09:13 means nothing
   without knowing whose morning that was. Spelled out component by component
   because dateStyle and timeStyle may not be combined with any other option —
   asking for those plus timeZoneName is a TypeError, and behind a catch it
   looks exactly like a locale that has no timezone name to give. */
const WHEN_FORMAT = {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
  timeZoneName: 'short',
};
function whenCell(ts) {
  const when = new Date(ts * 1000);
  return '<span class="meta-when">' + escHtml(when.toLocaleString(undefined, WHEN_FORMAT)) + '</span>';
}

/* One label, one value, every row the same shape. The date used to ride along
   in a third column so that the two dates lined up — which put it a name's
   width away from the name it belonged to, and stranded it against the far edge
   of the pane on any row that had one. A date is a field like the others. */
function metaRow(label, cells) {
  return '<div class="meta-label">' + escHtml(label) + '</div>'
    + '<div class="meta-cells">' + cells.join('') + '</div>';
}

function renderDetailPanel(detail) {
  state._lastDetail = detail;
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  // Who and when, then the hashes as chips: the glanceable half.
  let head = '<div class="detail-head">' + avatarHtml(detail.author, detail.authorEmail);
  head += '<div class="detail-who">';
  head += '<span class="detail-author" title="' + escHtml(detail.authorEmail) + '">' + escHtml(detail.author) + '</span>';
  head += '<span class="detail-when" title="' + escHtml(new Date(detail.authorDate * 1000).toLocaleString()) + '">committed ' + escHtml(formatDate(detail.authorDate)) + '</span>';
  if (detail.committer !== detail.author) {
    head += '<span class="detail-when" title="' + escHtml(detail.committerEmail) + '">via ' + escHtml(detail.committer) + '</span>';
  }
  head += '</div><div class="detail-head-actions">';
  head += '<span class="chip copyable" data-copy="' + escHtml(detail.hash) + '" title="Copy ' + escHtml(detail.hash) + '">' + escHtml(detail.hash.substring(0, 8)) + '</span>';
  for (const parent of detail.parents) {
    head += '<span class="chip copyable" data-copy="' + escHtml(parent) + '" title="Parent ' + escHtml(parent) + '">'
      + '<span class="chip-label">parent</span>' + escHtml(parent.substring(0, 7)) + '</span>';
  }
  head += '</div></div>';

  // Then the full values. The chips above are what you glance at and copy; a
  // hash you have to *read* is forty characters. Every row is always here, in
  // the same order, even when the committer repeats the author: a field that
  // comes and goes cannot be found by muscle memory, and the two dates only
  // mean anything next to each other — which is what a rebase or an amend does
  // to them, and the reason both are separate fields rather than one date.
  let meta = '<div class="detail-meta">';
  meta += metaRow('Commit', [hashCell(detail.hash)]);
  if (detail.parents.length > 0) {
    meta += metaRow(detail.parents.length > 1 ? 'Parents' : 'Parent', detail.parents.map(hashCell));
  }
  meta += metaRow('Author', [personCell(detail.author, detail.authorEmail)]);
  meta += metaRow('Author date', [whenCell(detail.authorDate)]);
  meta += metaRow('Committer', [personCell(detail.committer, detail.committerEmail)]);
  meta += metaRow('Commit date', [whenCell(detail.commitDate)]);
  meta += '</div>';

  // The subject carries the weight; the body keeps the author's own wrapping.
  const message = String(detail.message || '');
  const firstBreak = message.indexOf('\\n');
  const subject = firstBreak === -1 ? message : message.slice(0, firstBreak);
  const body = firstBreak === -1 ? '' : message.slice(firstBreak + 1).replace(/^\\n+/, '').replace(/\\s+$/, '');
  let left = '<div class="detail-msg">' + meta + '<div class="detail-subject">' + formatCommitMessage(subject) + '</div>';
  if (body) {
    // A paragraph the author wrapped at 72 columns is reflowed to the pane it
    // is actually in; a list or an aligned block keeps every break it had.
    let blocks = '';
    for (const block of splitCommitBody(body)) {
      blocks += block.kind === 'prose'
        ? '<p class="msg-p">' + formatCommitMessage(block.text) + '</p>'
        : '<pre class="msg-pre">' + formatCommitMessage(block.text) + '</pre>';
    }
    left += '<div class="detail-text">' + blocks + '</div>';
  }
  left += '</div>';

  let right = '';
  if (detail.fileChanges && detail.fileChanges.length > 0) {
    let added = 0, removed = 0;
    for (const f of detail.fileChanges) { added += f.additions || 0; removed += f.deletions || 0; }
    right = '<div class="detail-files"><div class="file-list"><div class="files-head">'
      + '<span>' + detail.fileChanges.length + (detail.fileChanges.length === 1 ? ' file' : ' files') + ' changed</span>'
      + '<span class="files-total">'
      + (added > 0 ? '<span class="add">+' + added + '</span> ' : '')
      + (removed > 0 ? '<span class="del">-' + removed + '</span>' : '')
      + '</span>' + fileViewToggleHtml() + '</div>'
      + renderFileListHtml(detail.fileChanges, detail.hash, detail.parents[0] || '')
      + '</div></div>';
  }

  // The split panes each own a scrollbar, which means the panel must stop
  // owning one — and must give it back for any other view written into it.
  panel.classList.toggle('split', !!right);
  panel.innerHTML = head + '<div class="detail-grid' + (right ? ' has-files' : '') + '">' + left + right + '</div>';
}

// --- Context menu ---
function showCommitContextMenu(x, y, commit) {
  const menu = document.getElementById('context-menu');
  const items = [
    { label: 'Copy Commit Hash', action: () => copyText(commit.hash) },
    { label: 'Copy Short Hash', action: () => copyText(commit.hash.substring(0, 7)) },
    { separator: true },
    { label: 'Checkout...', action: () => gitAction('checkout', { target: commit.hash }) },
    { label: 'Create Branch Here...', action: () => promptAndAction('Branch name:', (name) => gitAction('createBranch', { name, startPoint: commit.hash })) },
    { label: 'Create Tag Here...', action: () => promptAndAction('Tag name:', (name) => gitAction('createTag', { name, hash: commit.hash })) },
    { label: 'Create Worktree Here...', action: () => showCreateWorktreeDialog(commit.hash) },
    { separator: true },
    { label: 'Rebase current branch onto this...', action: () => {
      showDialog({
        title: 'Rebase',
        message: 'Rebase current branch (' + escHtml(state.currentBranch) + ') onto commit ' + commit.hash.substring(0, 7) + '?',
        rawMessage: true,
        confirmLabel: 'Rebase',
        onConfirm: () => gitAction('rebase', { branch: commit.hash }),
      });
    }},
  ];
  // Add "Create PR" if PR creation is configured and commit has a branch ref
  if (state.settings.prCreation && state.settings.prCreation.urlTemplate) {
    const branchRef = (commit.refs || []).find(r => r.type === 'local' || r.type === 'head');
    if (branchRef) {
      items.push({ separator: true });
      items.push({ label: 'Create Pull Request (' + branchRef.name + ')', action: () => openPrUrl(branchRef.name) });
    }
  }
  items.push(
    { separator: true },
    { label: 'Cherry-pick', action: () => gitAction('cherryPick', { hash: commit.hash }) },
    { label: 'Revert', action: () => gitAction('revert', { hash: commit.hash }) },
    { separator: true },
    { label: 'Interactive rebase from here...', action: () => vscode.postMessage({ command: 'openInteractiveRebase', base: commit.hash }) },
    { label: 'Compare with current branch...', action: () => vscode.postMessage({ command: 'openCompare', ref1: commit.hash, ref2: state.currentBranch || undefined }) },
    { separator: true },
    { label: 'Reset Current Branch to Here...', destructive: true, action: () => promptResetMode(commit.hash) },
  );

  let html = '';
  items.forEach((item, idx) => {
    if (item.separator) {
      html += '<div class="ctx-separator"></div>';
    } else {
      html += '<div class="ctx-item' + (item.destructive ? ' destructive' : '') + '" data-idx="' + idx + '">' + escHtml(item.label) + '</div>';
    }
  });
  menu.innerHTML = html;

  // Position (clamp to viewport)
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
  menu.classList.remove('hidden');

  // Bind click handlers
  menu.querySelectorAll('.ctx-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const item = items[idx];
    if (item && item.action) el.addEventListener('click', () => { hideContextMenu(); item.action(); });
  });

  // Close on click outside
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 0);
}

function showUncommittedContextMenu(x, y) {
  const menu = document.getElementById('context-menu');
  const items = [
    { label: 'Stash Uncommitted Changes...', action: () => {
      showDialog({
        title: 'Stash Changes',
        input: { placeholder: 'Stash message (optional)' },
        confirmLabel: 'Stash',
        onConfirm: (message) => gitAction('stashSave', message ? { message } : {}),
      });
    }},
    { label: 'Reset Uncommitted Changes...', destructive: true, action: () => {
      showDialog({
        title: 'Reset Changes',
        message: 'Reset all uncommitted changes. Staged changes will be unstaged.',
        select: { options: ['mixed', 'hard'], defaultValue: 'mixed', label: 'Reset mode:' },
        destructive: true,
        confirmLabel: 'Reset',
        onConfirm: (mode) => {
          if (mode === 'hard') {
            showDialog({
              title: 'Confirm Hard Reset',
              message: 'WARNING: --hard will permanently discard ALL uncommitted changes!',
              destructive: true,
              confirmLabel: 'Reset Hard',
              onConfirm: () => gitAction('reset', { mode: 'hard', hash: 'HEAD' }),
            });
          } else {
            gitAction('reset', { mode, hash: 'HEAD' });
          }
        },
      });
    }},
    { label: 'Clean Untracked Files...', destructive: true, action: () => {
      showDialog({
        title: 'Clean Untracked Files',
        message: 'Permanently delete all untracked files and directories. This cannot be undone!',
        destructive: true,
        confirmLabel: 'Clean',
        onConfirm: () => gitAction('clean', {}),
      });
    }},
    { separator: true },
    { label: 'Open Source Control View', action: () => vscode.postMessage({ command: 'openSourceControl' }) },
  ];

  let html = '';
  items.forEach((item, idx) => {
    if (item.separator) {
      html += '<div class="ctx-separator"></div>';
    } else {
      html += '<div class="ctx-item' + (item.destructive ? ' destructive' : '') + '" data-idx="' + idx + '">' + escHtml(item.label) + '</div>';
    }
  });
  menu.innerHTML = html;
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
  menu.classList.remove('hidden');
  menu.querySelectorAll('.ctx-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const item = items[idx];
    if (item && item.action) el.addEventListener('click', () => { hideContextMenu(); item.action(); });
  });
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 0);
}

function showBranchContextMenu(x, y, branchName, refType, commit) {
  const menu = document.getElementById('context-menu');
  const items = [];

  if (refType === 'head' || refType === 'local') {
    items.push(
      { label: 'Checkout "' + branchName + '"', action: () => gitAction('checkout', { target: branchName }) },
      { label: 'Merge into current branch', action: () => showDialog({
          title: 'Merge "' + branchName + '"',
          message: 'Merge "' + branchName + '" into the current branch?',
          confirmLabel: 'Merge',
          onConfirm: () => gitAction('merge', { branch: branchName }),
        })
      },
      { label: 'Rebase onto "' + branchName + '"', action: () => showDialog({
          title: 'Rebase onto "' + branchName + '"',
          message: 'Rebase current branch onto "' + branchName + '"?',
          confirmLabel: 'Rebase',
          onConfirm: () => gitAction('rebase', { branch: branchName }),
        })
      },
      { separator: true },
      { label: 'Rename branch...', action: () => showDialog({
          title: 'Rename Branch',
          input: { placeholder: 'New branch name', defaultValue: branchName },
          confirmLabel: 'Rename',
          onConfirm: (newName) => { if (newName && newName !== branchName) gitAction('renameBranch', { oldName: branchName, newName }); },
        })
      },
    );
    if (refType !== 'head') {
      items.push(
        { label: 'Delete branch...', destructive: true, action: () => showDialog({
            title: 'Delete Branch',
            message: 'Delete local branch "' + branchName + '"?',
            destructive: true,
            confirmLabel: 'Delete',
            onConfirm: () => gitAction('deleteBranch', { name: branchName, force: false }),
          })
        },
      );
    }
    if (state.settings.prCreation && state.settings.prCreation.urlTemplate) {
      items.push({ separator: true });
      items.push({ label: 'Create Pull Request', action: () => openPrUrl(branchName) });
    }
  } else if (refType === 'remote') {
    items.push(
      { label: 'Checkout as local branch', action: () => gitAction('checkout', { target: branchName }) },
      { separator: true },
      { label: 'Delete remote branch...', destructive: true, action: () => showDialog({
          title: 'Delete Remote Branch',
          message: 'Delete remote branch "' + branchName + '"? This cannot be undone.',
          destructive: true,
          confirmLabel: 'Delete',
          onConfirm: () => {
            const parts = branchName.split('/');
            const remote = parts[0];
            const branch = parts.slice(1).join('/');
            gitAction('push', { remote, branch, force: false, delete: true });
          },
        })
      },
    );
  } else if (refType === 'tag') {
    items.push(
      { label: 'Checkout tag "' + branchName + '"', action: () => gitAction('checkout', { target: branchName }) },
      { separator: true },
      { label: 'Delete tag...', destructive: true, action: () => showDialog({
          title: 'Delete Tag',
          message: 'Delete tag "' + branchName + '"?',
          destructive: true,
          confirmLabel: 'Delete',
          onConfirm: () => gitAction('deleteTag', { name: branchName }),
        })
      },
    );
  }

  let html = '';
  items.forEach((item, idx) => {
    if (item.separator) {
      html += '<div class="ctx-separator"></div>';
    } else {
      html += '<div class="ctx-item' + (item.destructive ? ' destructive' : '') + '" data-idx="' + idx + '">' + escHtml(item.label) + '</div>';
    }
  });
  menu.innerHTML = html;
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
  menu.classList.remove('hidden');
  menu.querySelectorAll('.ctx-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const item = items[idx];
    if (item && item.action) el.addEventListener('click', () => { hideContextMenu(); item.action(); });
  });
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 0);
}

function showStashBadgeMenu(x, y, stashRef) {
  const menu = document.getElementById('context-menu');
  const items = [
    { label: 'Apply (keep stash)', action: () => gitAction('stashApply', { stashRef }) },
    { label: 'Pop (apply & remove)', action: () => gitAction('stashPop', { stashRef }) },
    { separator: true },
    { label: 'Drop stash...', destructive: true, action: () => showDialog({
        title: 'Drop Stash',
        message: 'Delete ' + stashRef + '? This cannot be undone.',
        destructive: true,
        confirmLabel: 'Drop',
        onConfirm: () => gitAction('stashDrop', { stashRef }),
      })
    },
  ];
  let html = '';
  items.forEach((item, idx) => {
    if (item.separator) {
      html += '<div class="ctx-separator"></div>';
    } else {
      html += '<div class="ctx-item' + (item.destructive ? ' destructive' : '') + '" data-idx="' + idx + '">' + escHtml(item.label) + '</div>';
    }
  });
  menu.innerHTML = html;
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
  menu.classList.remove('hidden');
  menu.querySelectorAll('.ctx-item').forEach(el => {
    const idx = parseInt(el.dataset.idx);
    const item = items[idx];
    if (item && item.action) el.addEventListener('click', () => { hideContextMenu(); item.action(); });
  });
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 0);
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

function gitAction(action, args) {
  vscode.postMessage({ command: 'gitAction', action, args });
}

function promptAndAction(title, callback) {
  showDialog({ title, input: { placeholder: title }, onConfirm: (val) => { if (val) callback(val); } });
}

function promptResetMode(hash) {
  showDialog({
    title: 'Reset Current Branch',
    select: { options: ['soft', 'mixed', 'hard'], defaultValue: 'mixed', label: 'Reset mode:' },
    onConfirm: (mode) => {
      if (mode === 'hard') {
        showDialog({
          title: 'Confirm Hard Reset',
          message: 'WARNING: --hard will discard ALL uncommitted changes. This cannot be undone!',
          destructive: true,
          confirmLabel: 'Reset Hard',
          onConfirm: () => gitAction('reset', { mode, hash }),
        });
      } else {
        gitAction('reset', { mode, hash });
      }
    },
  });
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

// --- Dialog system ---
function showDialog(opts) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.innerHTML = '<h3>' + escHtml(opts.title || 'Dialog') + '</h3>';
  if (opts.message) {
    const msgHtml = opts.rawMessage ? opts.message : escHtml(opts.message);
    dialog.innerHTML += '<p' + (opts.destructive ? ' class="warning"' : '') + '>' + msgHtml + '</p>';
  }

  let inputEl = null;
  if (opts.input) {
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = opts.input.placeholder || '';
    if (opts.input.defaultValue) inputEl.value = opts.input.defaultValue;
    dialog.appendChild(inputEl);
  }
  if (opts.select) {
    if (opts.select.label) dialog.innerHTML += '<p>' + escHtml(opts.select.label) + '</p>';
    inputEl = document.createElement('select');
    opts.select.options.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      if (o === opts.select.defaultValue) opt.selected = true;
      inputEl.appendChild(opt);
    });
    dialog.appendChild(inputEl);
  }

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = opts.cancelLabel || 'Cancel';
  cancelBtn.className = 'secondary';
  cancelBtn.addEventListener('click', () => overlay.remove());
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = opts.confirmLabel || 'OK';
  confirmBtn.className = opts.destructive ? 'btn-danger' : 'btn-primary';
  confirmBtn.addEventListener('click', () => {
    overlay.remove();
    if (opts.onConfirm) opts.onConfirm(inputEl ? inputEl.value : undefined);
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Focus input and handle Enter/Escape
  if (inputEl) setTimeout(() => inputEl.focus(), 50);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
    if (e.key === 'Enter') confirmBtn.click();
  });
}

// --- Mobile long-press ---
function setupLongPress(el, callback) {
  let timer = null;
  let startX = 0, startY = 0;
  el.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = setTimeout(() => { e.preventDefault(); callback(startX, startY); }, 500);
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    if (timer && (Math.abs(e.touches[0].clientX - startX) > 10 || Math.abs(e.touches[0].clientY - startY) > 10)) {
      clearTimeout(timer); timer = null;
    }
  }, { passive: true });
  el.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('touchcancel', () => { if (timer) { clearTimeout(timer); timer = null; } });
}

// --- Text formatter (URLs, issues, commit hashes) ---
${COMMIT_MESSAGE_JS}

// --- Find widget ---
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');

document.getElementById('btn-reflog').addEventListener('click', () => vscode.postMessage({ command: 'openReflog' }));
document.getElementById('btn-find').addEventListener('click', toggleFind);

function toggleFind() {
  findBar.classList.toggle('hidden');
  if (!findBar.classList.contains('hidden')) findInput.focus();
  else clearSearch();
}

const findMode = document.getElementById('find-mode');
const searchResultsEl = document.getElementById('search-results');

/*
 * "Loaded rows" keeps the original behaviour: highlight matches among the rows
 * already rendered. The other modes run in git over the whole history, because a
 * commit older than the current page is otherwise invisible to a search.
 */
findInput.addEventListener('input', () => {
  if (findMode.value === 'loaded') doSearch(findInput.value);
});

findInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || findMode.value === 'loaded') return;
  e.preventDefault();
  runHistorySearch();
});

findMode.addEventListener('change', () => {
  clearSearchHighlights();
  hideSearchResults();
  document.getElementById('find-count').textContent = '';
  if (findMode.value === 'loaded') doSearch(findInput.value);
  else if (findInput.value.trim()) runHistorySearch();
  findInput.placeholder = findMode.value === 'loaded'
    ? 'Search commits...'
    : findMode.value === 'file' ? 'Path, then Enter…' : 'Type, then Enter…';
});

function runHistorySearch() {
  const text = findInput.value.trim();
  if (!text) { hideSearchResults(); return; }
  document.getElementById('find-count').textContent = 'searching…';
  vscode.postMessage({ command: 'searchCommits', mode: findMode.value, text });
}

function hideSearchResults() {
  searchResultsEl.classList.add('hidden');
  searchResultsEl.innerHTML = '';
}

function renderSearchResults(data) {
  const hits = data.hits || [];
  document.getElementById('find-count').textContent = hits.length + ' match(es)';
  if (!hits.length) {
    searchResultsEl.innerHTML = '<div class="sr-head">Nothing in this repository matches.</div>';
    searchResultsEl.classList.remove('hidden');
    return;
  }
  const loaded = new Set(getDisplayCommits().map(c => c.hash));
  searchResultsEl.innerHTML = '<div class="sr-head">' + hits.length + ' commit(s) across all history — click to open</div>'
    + hits.map(h =>
      '<div class="sr-item" data-hash="' + escHtml(h.hash) + '">'
        + '<div class="sr-subject">' + escHtml(h.subject) + '</div>'
        + '<div class="sr-meta">' + avatarHtml(h.author, h.authorEmail)
          + '<span>' + escHtml(h.author) + '</span>'
          + '<span>' + escHtml(formatDate(h.authorDate)) + '</span>'
          + '<span class="sr-hash">' + escHtml(h.hash.substring(0, 7)) + '</span>'
          + (loaded.has(h.hash) ? '' : '<span>not in the loaded range</span>')
        + '</div>'
      + '</div>').join('');
  searchResultsEl.classList.remove('hidden');
}

searchResultsEl.addEventListener('click', (e) => {
  const item = e.target.closest('.sr-item');
  if (!item) return;
  const hash = item.dataset.hash;
  hideSearchResults();
  // Scroll to the row when this commit is on screen; otherwise just open its
  // details, since loading the intervening history could be thousands of rows.
  const row = document.querySelector('.commit-row[data-hash="' + hash + '"]');
  if (row) { selectCommit(hash); row.scrollIntoView({ block: 'center' }); }
  else { selectCommit(hash); }
});

document.getElementById('find-next').addEventListener('click', () => navigateSearch(1));
document.getElementById('find-prev').addEventListener('click', () => navigateSearch(-1));
document.getElementById('find-close').addEventListener('click', () => { findBar.classList.add('hidden'); clearSearch(); });

function doSearch(query) {
  clearSearchHighlights();
  state.searchMatches = [];
  state.searchIndex = -1;
  if (!query.trim()) { document.getElementById('find-count').textContent = ''; return; }
  const q = query.toLowerCase();
  const displayCommits = getDisplayCommits();
  document.querySelectorAll('.commit-row:not(.header-row)').forEach((row, idx) => {
    const commit = displayCommits[idx];
    if (!commit || commit.hash === 'uncommitted') return;
    const match = commit.message.toLowerCase().includes(q) ||
      commit.author.toLowerCase().includes(q) ||
      commit.hash.toLowerCase().startsWith(q);
    if (match) { state.searchMatches.push(idx); row.classList.add('search-match'); }
  });
  document.getElementById('find-count').textContent = state.searchMatches.length + ' match(es)';
  renderScrollMarkers();
  if (state.searchMatches.length > 0) navigateSearch(0);
}

function navigateSearch(dir) {
  if (state.searchMatches.length === 0) return;
  if (dir === 0) state.searchIndex = 0;
  else state.searchIndex = (state.searchIndex + dir + state.searchMatches.length) % state.searchMatches.length;
  const idx = state.searchMatches[state.searchIndex];
  const rows = document.querySelectorAll('.commit-row:not(.header-row)');
  if (rows[idx]) rows[idx].scrollIntoView({ block: 'center' });
  document.getElementById('find-count').textContent = (state.searchIndex + 1) + ' of ' + state.searchMatches.length;
}

function clearSearch() {
  clearSearchHighlights();
  hideSearchResults();
  state.searchMatches = [];
  state.searchIndex = -1;
  findInput.value = '';
  document.getElementById('find-count').textContent = '';
  renderScrollMarkers();
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'));
}

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); toggleFind(); }
  if (e.key === 'Escape') {
    hideContextMenu();
    if (!findBar.classList.contains('hidden')) { findBar.classList.add('hidden'); clearSearch(); }
    else if (state.expandedCommit) { state.selectedCommit = null; state.expandedCommit = null; document.getElementById('detail-panel').classList.add('hidden'); document.querySelectorAll('.commit-row.selected').forEach(el => el.classList.remove('selected')); }
  }
});

// --- Scroll to load more ---
document.getElementById('graph-container').addEventListener('scroll', (e) => {
  const container = e.target;
  if (container.scrollTop + container.clientHeight >= container.scrollHeight - 50) {
    if (!state.loading && state.commits.length >= state.maxCommits) {
      state.loading = true;
      document.getElementById('loading').classList.remove('hidden');
      vscode.postMessage({ command: 'requestCommits', maxCommits: state.maxCommits, skip: state.commits.length });
    }
  }
});

// --- Utilities ---
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
${AVATAR_JS}

/* --- Author hover card --- */
let authorCardEl = null;
function showAuthorCard(anchorEl, commit) {
  hideAuthorCard();
  const rect = anchorEl.getBoundingClientRect();
  const card = document.createElement('div');
  card.className = 'author-card';
  card.innerHTML = '<div class="ac-head">' + avatarHtml(commit.author, commit.authorEmail)
      + escHtml(commit.author) + '</div>'
    + '<div class="ac-row">' + escHtml(commit.authorEmail || '') + '</div>'
    + '<div class="ac-row">authored ' + escHtml(formatDate(commit.authorDate)) + '</div>'
    + (commit.committer && commit.committer !== commit.author
        ? '<div class="ac-row">committed by ' + escHtml(commit.committer) + '</div>'
        : '')
    + '<div class="ac-row">' + escHtml(commit.hash.substring(0, 10)) + '</div>';
  document.body.appendChild(card);
  // Flip above the row when the card would fall off the bottom.
  const cardRect = card.getBoundingClientRect();
  const top = rect.bottom + cardRect.height > window.innerHeight ? rect.top - cardRect.height - 4 : rect.bottom + 4;
  card.style.top = Math.max(4, top) + 'px';
  card.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - cardRect.width - 4)) + 'px';
  authorCardEl = card;
}
function hideAuthorCard() {
  if (authorCardEl) { authorCardEl.remove(); authorCardEl = null; }
}

/* --- Drag a ref badge onto a commit to merge or rebase onto it --- */
let dragRef = null;

function makeRefDraggable(badge, refName, refType) {
  // Only branches can be merged or rebased; tags and stashes cannot.
  if (refType === 'tag' || refType === 'stash') return;
  badge.draggable = true;
  badge.addEventListener('dragstart', (e) => {
    dragRef = { name: refName, type: refType };
    badge.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', refName);
    e.stopPropagation();
  });
  badge.addEventListener('dragend', () => {
    dragRef = null;
    badge.classList.remove('dragging');
    document.querySelectorAll('.commit-row.drop-target').forEach(r => r.classList.remove('drop-target'));
  });
}

function makeRowDropTarget(row, commit) {
  if (commit.hash === 'uncommitted' || commit._isStash) return;
  row.addEventListener('dragover', (e) => {
    if (!dragRef) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', (e) => {
    if (!dragRef) return;
    e.preventDefault();
    row.classList.remove('drop-target');
    showDropActionMenu(e.clientX, e.clientY, dragRef, commit);
    dragRef = null;
  });
}

function showDropActionMenu(x, y, ref, commit) {
  const short = commit.hash.substring(0, 7);
  const onCurrent = ref.name === state.currentBranch;
  const items = [];
  if (onCurrent) {
    // Dragging the checked-out branch onto a commit = move this branch there.
    items.push({ label: 'Rebase ' + ref.name + ' onto ' + short, action: () => showDialog({
      title: 'Rebase',
      message: 'Rebase ' + escHtml(ref.name) + ' onto commit ' + short + '?',
      rawMessage: true,
      confirmLabel: 'Rebase',
      onConfirm: () => gitAction('rebase', { branch: commit.hash }),
    }) });
  } else {
    items.push({ label: 'Merge ' + ref.name + ' into ' + (state.currentBranch || 'HEAD'), action: () => showDialog({
      title: 'Merge',
      message: 'Merge ' + escHtml(ref.name) + ' into ' + escHtml(state.currentBranch || 'HEAD') + '?',
      rawMessage: true,
      confirmLabel: 'Merge',
      onConfirm: () => gitAction('merge', { branch: ref.name }),
    }) });
    items.push({ label: 'Rebase ' + (state.currentBranch || 'HEAD') + ' onto ' + ref.name, action: () => showDialog({
      title: 'Rebase',
      message: 'Rebase ' + escHtml(state.currentBranch || 'HEAD') + ' onto ' + escHtml(ref.name) + '?',
      rawMessage: true,
      confirmLabel: 'Rebase',
      onConfirm: () => gitAction('rebase', { branch: ref.name }),
    }) });
  }
  items.push({ separator: true });
  items.push({ label: 'Compare ' + ref.name + ' with ' + short, action: () => vscode.postMessage({ command: 'openCompare', ref1: ref.name, ref2: commit.hash }) });
  renderContextMenu(x, y, items);
}

/**
 * Render a context menu from an item list. The older menu builders each inline
 * this same block; new menus go through here.
 */
function renderContextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  let html = '';
  items.forEach((item, idx) => {
    if (item.separator) {
      html += '<div class="ctx-separator"></div>';
    } else {
      html += '<div class="ctx-item' + (item.destructive ? ' destructive' : '') + '" data-idx="' + idx + '">' + escHtml(item.label) + '</div>';
    }
  });
  menu.innerHTML = html;
  menu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 300) + 'px';
  menu.classList.remove('hidden');
  menu.querySelectorAll('.ctx-item').forEach(el => {
    const item = items[parseInt(el.dataset.idx)];
    if (item && item.action) el.addEventListener('click', () => { hideContextMenu(); item.action(); });
  });
  setTimeout(() => document.addEventListener('click', hideContextMenu, { once: true }), 0);
}


function formatDate(ts) {
  const fmt = state.settings.dateFormat;
  if (fmt === 'iso') return new Date(ts * 1000).toISOString().substring(0, 16).replace('T', ' ');
  if (fmt === 'absolute') return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
  if (diff < 31536000) return Math.floor(diff / 2592000) + 'mo ago';
  return Math.floor(diff / 31536000) + 'y ago';
}

function updateStatus() {
  const parts = [];
  if (state.currentBranch) parts.push(state.currentBranch);
  parts.push(state.commits.length + ' commits');
  parts.push(state.branches.length + ' branches');
  parts.push(state.tags.length + ' tags');
  document.getElementById('status-text').textContent = parts.join(' | ');
}

// --- Settings panel ---
const settingsPanel = document.getElementById('settings-panel');

document.getElementById('btn-settings').addEventListener('click', () => {
  const isOpen = settingsPanel.classList.toggle('open');
  if (isOpen) {
    vscode.postMessage({ command: 'requestSettings' });
    vscode.postMessage({ command: 'requestUserDetails' });
    renderRemotesList();
  }
});
document.getElementById('settings-close').addEventListener('click', () => {
  settingsPanel.classList.remove('open');
});

function applySettingsToUI() {
  const s = state.settings;
  document.getElementById('s-maxCommits').value = s.maxCommits;
  document.getElementById('s-showTags').checked = s.showTags;
  document.getElementById('s-showStashes').checked = s.showStashes;
  document.getElementById('s-showRemoteBranches').checked = s.showRemoteBranches;
  document.getElementById('s-graphStyle').value = s.graphStyle;
  document.getElementById('s-firstParentOnly').checked = s.firstParentOnly;
  document.getElementById('s-dateFormat').value = s.dateFormat;
  document.getElementById('s-commitOrdering').value = s.commitOrdering;
  document.getElementById('s-autoFetchInterval').value = s.autoFetchInterval || 0;
  graphConfig.style = s.graphStyle;
  startAutoFetch(s.autoFetchInterval);
  renderIssueRules();
  applyPrSettingsToUI();
}

// General setting change handlers
['showTags', 'showStashes', 'showRemoteBranches', 'firstParentOnly'].forEach(key => {
  document.getElementById('s-' + key).addEventListener('change', (e) => {
    vscode.postMessage({ command: 'updateSetting', key, value: e.target.checked });
    state.settings[key] = e.target.checked;
    renderCommitList();
  });
});
['graphStyle', 'dateFormat', 'commitOrdering'].forEach(key => {
  document.getElementById('s-' + key).addEventListener('change', (e) => {
    vscode.postMessage({ command: 'updateSetting', key, value: e.target.value });
    state.settings[key] = e.target.value;
    if (key === 'graphStyle') graphConfig.style = e.target.value;
    if (key === 'dateFormat') renderCommitList();
  });
});
document.getElementById('s-maxCommits').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (n > 0 && n <= 10000) {
    state.maxCommits = n;
    state.settings.maxCommits = n;
    vscode.postMessage({ command: 'updateSetting', key: 'maxCommits', value: n });
  }
});
document.getElementById('s-autoFetchInterval').addEventListener('change', (e) => {
  const val = parseInt(e.target.value, 10);
  state.settings.autoFetchInterval = val;
  vscode.postMessage({ command: 'updateSetting', key: 'autoFetchInterval', value: val });
  startAutoFetch(val);
});

// User details
document.getElementById('s-saveUser').addEventListener('click', () => {
  const name = document.getElementById('s-userName').value.trim();
  const email = document.getElementById('s-userEmail').value.trim();
  vscode.postMessage({ command: 'updateUserDetails', name, email });
});

// Remotes
function renderRemotesList() {
  const container = document.getElementById('s-remotes-list');
  if (state.remotes.length === 0) {
    container.innerHTML = '<p style="font-size:12px;color:var(--subtext)">No remotes configured.</p>';
    return;
  }
  container.innerHTML = state.remotes.map(r =>
    '<div class="remote-item">' +
      '<div class="remote-name">' + escHtml(r.name) + '</div>' +
      '<div class="remote-url">' + escHtml(r.fetchUrl) + '</div>' +
      '<div class="remote-actions">' +
        '<button class="btn-sm" data-edit-remote="' + escHtml(r.name) + '">Edit URL</button>' +
        '<button class="btn-sm" style="color:var(--red)" data-rm-remote="' + escHtml(r.name) + '">Remove</button>' +
      '</div>' +
    '</div>'
  ).join('');
}

document.getElementById('s-remotes-list').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-edit-remote]');
  if (editBtn) {
    const name = editBtn.dataset.editRemote;
    const remote = state.remotes.find(r => r.name === name);
    showDialog({
      title: 'Edit Remote URL: ' + name,
      input: { placeholder: 'New URL', defaultValue: remote ? remote.fetchUrl : '' },
      onConfirm: (url) => { if (url) vscode.postMessage({ command: 'editRemoteUrl', name, url }); },
    });
    return;
  }
  const rmBtn = e.target.closest('[data-rm-remote]');
  if (rmBtn) {
    const name = rmBtn.dataset.rmRemote;
    showDialog({
      title: 'Remove Remote',
      message: 'Remove remote "' + name + '"? This cannot be undone.',
      destructive: true,
      confirmLabel: 'Remove',
      onConfirm: () => vscode.postMessage({ command: 'removeRemote', name }),
    });
  }
});

document.getElementById('s-addRemote').addEventListener('click', () => {
  const name = document.getElementById('s-newRemoteName').value.trim();
  const url = document.getElementById('s-newRemoteUrl').value.trim();
  if (name && url) {
    vscode.postMessage({ command: 'addRemote', name, url });
    document.getElementById('s-newRemoteName').value = '';
    document.getElementById('s-newRemoteUrl').value = '';
  }
});

// --- Issue Linking ---
function renderIssueRules() {
  const rules = state.settings.issueLinkingRules || [];
  const container = document.getElementById('issue-rules-list');
  container.innerHTML = rules.map((r, i) =>
    '<div class="issue-rule-row" data-idx="' + i + '">' +
      '<input type="text" class="rule-pattern" placeholder="Regex, e.g. #(\\d+)" value="' + escHtml(r.pattern) + '">' +
      '<input type="text" class="rule-url" placeholder="URL with $1, e.g. https://..." value="' + escHtml(r.url) + '">' +
      '<button class="rule-remove" title="Remove">&times;</button>' +
    '</div>'
  ).join('');
}

let issueRuleDebounce = null;
document.getElementById('issue-rules-list').addEventListener('input', (e) => {
  const row = e.target.closest('.issue-rule-row');
  if (!row) return;
  const idx = parseInt(row.dataset.idx);
  const rules = [...(state.settings.issueLinkingRules || [])];
  if (!rules[idx]) return;
  if (e.target.classList.contains('rule-pattern')) {
    rules[idx] = { ...rules[idx], pattern: e.target.value };
    try { new RegExp(e.target.value); e.target.classList.remove('rule-error'); }
    catch { e.target.classList.add('rule-error'); return; }
  }
  if (e.target.classList.contains('rule-url')) {
    rules[idx] = { ...rules[idx], url: e.target.value };
  }
  state.settings.issueLinkingRules = rules;
  clearTimeout(issueRuleDebounce);
  issueRuleDebounce = setTimeout(() => {
    vscode.postMessage({ command: 'updateSetting', key: 'issueLinkingRules', value: rules });
  }, 500);
});

document.getElementById('issue-rules-list').addEventListener('click', (e) => {
  if (!e.target.closest('.rule-remove')) return;
  const row = e.target.closest('.issue-rule-row');
  const idx = parseInt(row.dataset.idx);
  const rules = [...(state.settings.issueLinkingRules || [])];
  rules.splice(idx, 1);
  state.settings.issueLinkingRules = rules;
  vscode.postMessage({ command: 'updateSetting', key: 'issueLinkingRules', value: rules });
  renderIssueRules();
});

document.getElementById('add-issue-rule').addEventListener('click', () => {
  const rules = [...(state.settings.issueLinkingRules || []), { pattern: '', url: '' }];
  state.settings.issueLinkingRules = rules;
  vscode.postMessage({ command: 'updateSetting', key: 'issueLinkingRules', value: rules });
  renderIssueRules();
});

// --- PR Creation ---
const PR_TEMPLATES = {
  github: 'https://github.com/\${owner}/\${repo}/compare/\${targetBranch}...\${sourceBranch}?expand=1',
  gitlab: 'https://gitlab.com/\${owner}/\${repo}/-/merge_requests/new?source_branch=\${sourceBranch}&target_branch=\${targetBranch}',
  bitbucket: 'https://bitbucket.org/\${owner}/\${repo}/pull-requests/new?source=\${sourceBranch}&dest=\${targetBranch}',
  custom: '',
};

document.getElementById('pr-provider').addEventListener('change', (e) => {
  const provider = e.target.value;
  const prConfig = document.getElementById('pr-config');
  if (!provider) {
    prConfig.classList.add('hidden');
    state.settings.prCreation = null;
    vscode.postMessage({ command: 'updateSetting', key: 'prCreation', value: null });
    return;
  }
  prConfig.classList.remove('hidden');
  document.getElementById('pr-url-template').value = PR_TEMPLATES[provider] || '';
  document.getElementById('pr-target').value = 'main';
  vscode.postMessage({ command: 'requestOwnerRepo' });
});

document.getElementById('pr-save').addEventListener('click', () => {
  const provider = document.getElementById('pr-provider').value;
  if (!provider) return;
  const config = {
    provider,
    urlTemplate: document.getElementById('pr-url-template').value.trim(),
    owner: document.getElementById('pr-owner').value.trim(),
    repo: document.getElementById('pr-repo').value.trim(),
    defaultTargetBranch: document.getElementById('pr-target').value.trim() || 'main',
  };
  state.settings.prCreation = config;
  vscode.postMessage({ command: 'updateSetting', key: 'prCreation', value: config });
});

function applyPrSettingsToUI() {
  const pr = state.settings.prCreation;
  if (!pr) {
    document.getElementById('pr-provider').value = '';
    document.getElementById('pr-config').classList.add('hidden');
    return;
  }
  document.getElementById('pr-provider').value = pr.provider;
  document.getElementById('pr-config').classList.remove('hidden');
  document.getElementById('pr-owner').value = pr.owner || '';
  document.getElementById('pr-repo').value = pr.repo || '';
  document.getElementById('pr-target').value = pr.defaultTargetBranch || 'main';
  document.getElementById('pr-url-template').value = pr.urlTemplate || '';
}

function openPrUrl(sourceBranch) {
  const pr = state.settings.prCreation;
  if (!pr || !pr.urlTemplate) return;
  const url = pr.urlTemplate
    .replace(/\\$\\{owner\\}/g, encodeURIComponent(pr.owner))
    .replace(/\\$\\{repo\\}/g, encodeURIComponent(pr.repo))
    .replace(/\\$\\{sourceBranch\\}/g, encodeURIComponent(sourceBranch))
    .replace(/\\$\\{targetBranch\\}/g, encodeURIComponent(pr.defaultTargetBranch || 'main'));
  window.open(url, '_blank');
}
`;
}
