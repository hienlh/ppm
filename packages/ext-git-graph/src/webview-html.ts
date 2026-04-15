/**
 * Generate the complete webview HTML for the git graph panel.
 * All JS + CSS is inlined since webview runs in an iframe sandbox.
 */

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
        <button id="btn-find" title="Find (Ctrl+F)"></button>
        <button id="btn-settings" title="Settings"></button>
      </div>
    </header>
    <div id="find-bar" class="find-bar hidden">
      <input id="find-input" type="text" placeholder="Search commits..." />
      <span id="find-count"></span>
      <button id="find-prev" title="Previous">&uarr;</button>
      <button id="find-next" title="Next">&darr;</button>
      <button id="find-close" title="Close">&times;</button>
    </div>
    <div id="graph-container">
      <div id="graph-header" class="commit-row header-row">
        <div class="col-graph">Graph<div class="graph-resize-handle" id="graph-resize-handle"></div></div>
        <div class="col-message">Message</div>
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

function getStyles(): string {
  return `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #ffffff; --surface: #f4f4f5; --text: #09090b; --subtext: #71717a; --subtle: #a1a1aa;
  --border: #e4e4e7; --border2: #d4d4d8; --blue: #3b82f6; --red: #ef4444; --green: #22c55e;
  --yellow: #eab308; --purple: #8b5cf6; --orange: #f97316;
  --surface-hover: #f4f4f5; --selected: #eff6ff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b; --surface: #18181b; --text: #fafafa; --subtext: #a1a1aa; --subtle: #52525b;
    --border: #27272a; --border2: #3f3f46; --selected: #1e293b; --surface-hover: #27272a;
  }
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); font-size: 12px; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
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

/* Graph container */
#graph-container { flex: 1; overflow-y: auto; overflow-x: hidden; }
.commit-row { display: flex; align-items: center; cursor: pointer; min-height: 24px; padding: 0 6px; font-size: 12px; }
.commit-row:hover { background: var(--surface-hover); }
.commit-row.selected { background: var(--selected); }
.commit-row.header-row { background: var(--surface); cursor: default; font-weight: 600; font-size: 10px; color: var(--subtext); text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; z-index: 2; border-bottom: 1px solid var(--border); min-height: 22px; }
.commit-row.search-match { background: rgba(234, 179, 8, 0.15); }
.commit-row.virtual { opacity: 0.85; font-style: italic; }
.commit-row.virtual .col-message { color: var(--subtext); }
.commit-row.stash-row { opacity: 0.75; }
.commit-row.stash-row .col-message { color: var(--subtext); font-style: italic; }
.file-clickable { cursor: pointer; border-radius: 3px; padding: 2px 4px; margin: 0 -4px; }
.file-clickable:hover { background: var(--surface-hover); }
.col-graph { width: var(--graph-col-w, 120px); min-width: var(--graph-col-w, 80px); overflow: hidden; flex-shrink: 0; position: relative; }
.graph-resize-handle { position: absolute; right: 0; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 3; background: transparent; }
.graph-resize-handle:hover, .graph-resize-handle.dragging { background: var(--blue); opacity: 0.5; }
.col-message { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 6px; }
.col-author { width: 100px; min-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--subtext); font-size: 11px; }
.col-date { width: 80px; min-width: 80px; color: var(--subtext); font-size: 11px; }
.col-hash { width: 60px; min-width: 60px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 10px; color: var(--subtle); }

/* Ref badges */
.ref-badge { display: inline-block; padding: 0px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; margin-right: 3px; vertical-align: middle; line-height: 16px; }
.ref-head { background: var(--green); color: #fff; }
.ref-local { background: var(--blue); color: #fff; }
.ref-remote { background: var(--purple); color: #fff; }
.ref-tag { background: var(--yellow); color: #000; }
.ref-stash { background: #808080; color: #fff; }

/* SVG graph — single SVG overlay */
#commit-list-wrapper { position: relative; }
#graph-svg-container { position: absolute; top: 0; left: 8px; z-index: 1; pointer-events: none; }
#graph-svg-container circle { pointer-events: auto; cursor: pointer; }
#graph-svg-container .line { stroke-width: 2; fill: none; }
#graph-svg-container .graphCurrent { fill: var(--bg); stroke-width: 2; }
.commit-row.graph-hover { background: var(--surface-hover); }

/* Detail panel */
.detail-panel { border-top: 1px solid var(--border2); background: var(--surface); max-height: 40vh; overflow-y: auto; padding: 8px 12px; flex-shrink: 0; }
.detail-panel h3 { font-size: 13px; margin-bottom: 6px; }
.detail-field { margin-bottom: 3px; font-size: 11px; }
.detail-field .label { color: var(--subtext); display: inline-block; width: 80px; }
.detail-message { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px; margin: 6px 0; font-size: 11px; white-space: pre-wrap; font-family: 'SF Mono', 'Fira Code', monospace; }
.file-list { margin-top: 8px; }
.file-item { display: flex; align-items: center; gap: 5px; padding: 1px 0; font-size: 11px; font-family: 'SF Mono', 'Fira Code', monospace; }
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
.file-actions { display: flex; gap: 2px; margin-left: auto; flex-shrink: 0; }
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
.remote-item .remote-url { color: var(--subtext); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; word-break: break-all; }
.remote-actions { display: flex; gap: 4px; margin-top: 4px; }
.add-remote-form { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.add-remote-form input { background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 4px 6px; font-size: 12px; }
.issue-rule-row { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; }
.issue-rule-row input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 3px 6px; font-size: 11px; font-family: 'SF Mono', 'Fira Code', monospace; }
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

/* Touch targets for mobile */
@media (max-width: 768px) {
  .commit-row { min-height: 44px; }
  .ctx-item { padding: 10px 16px; min-height: 44px; }
  button { min-width: 44px; min-height: 44px; }
  .col-author, .col-hash { display: none; }
  .col-date { width: 60px; min-width: 60px; }
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
  grid: { x: 16, y: 24, offsetX: 8, offsetY: 12, expandY: 60 },
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
  searchIndex: -1,
  settings: { ...DEFAULT_SETTINGS },
  userDetails: { name: '', email: '' },
  graphColWidth: null,
  fileViewMode: 'list',
  worktrees: [],
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
document.getElementById('btn-find').innerHTML = ICONS.search;
document.getElementById('btn-settings').innerHTML = ICONS.settings;
document.getElementById('btn-worktree').innerHTML = ICONS.gitBranch + ' <span class="wt-count" style="display:none">0</span>';
document.getElementById('btn-stash').innerHTML = ICONS.archive + ' <span class="stash-count" style="display:none">0</span>';
vscode.postMessage({ command: 'ready' });

// --- Message handler ---
window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.command) {
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

// --- File click delegation (opens diff tab) ---
document.getElementById('detail-panel').addEventListener('click', (e) => {
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
  constructor(id, isStash) {
    this.id = id;
    this.isStash = isStash;
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

  draw(svg, config, expandOffset, overListener, outListener) {
    if (this._onBranch === null) return;
    const STASH_COLOR = '#808080';
    const colour = this.isStash ? STASH_COLOR
      : this._isCommitted ? config.colours[this._onBranch.getColour() % config.colours.length] : '#808080';
    const cx = (this._x * config.grid.x + config.grid.offsetX).toString();
    const cy = (this.id * config.grid.y + config.grid.offsetY + (expandOffset ? config.grid.expandY : 0)).toString();

    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.dataset.id = this.id.toString();
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', '4');
    if (this._isCurrent) {
      circle.setAttribute('class', 'graphCurrent');
      circle.setAttribute('stroke', colour);
    } else {
      circle.setAttribute('fill', colour);
    }
    svg.appendChild(circle);

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
    gVertices.push(new GVertex(i, !!commits[i]._isStash));
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

  // Detect mobile: match CSS breakpoint where row height changes to 44px
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const cfg = isMobile
    ? { ...graphConfig, grid: { ...graphConfig.grid, y: 44, offsetY: 22 } }
    : graphConfig;

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
    e.target.setAttribute('r', '5');
  }
}
function graphVertexOut(e) {
  if (!e.target || !e.target.dataset || !e.target.dataset.id) return;
  const id = parseInt(e.target.dataset.id);
  if (id >= 0) {
    const rows = document.querySelectorAll('.commit-row:not(.header-row)');
    if (rows[id]) rows[id].classList.remove('graph-hover');
    e.target.setAttribute('r', '4');
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

    // Graph spacer column (SVG overlays this area)
    const graphCol = document.createElement('div');
    graphCol.className = 'col-graph';

    // Message column with ref badges
    const msgCol = document.createElement('div');
    msgCol.className = 'col-message';
    let badges = '';
    if (commit.refs) {
      commit.refs.forEach(ref => {
        if (ref.type === 'tag' && !state.settings.showTags) return;
        if (ref.type === 'remote' && !state.settings.showRemoteBranches) return;
        badges += '<span class="ref-badge ref-' + ref.type + '">' + escHtml(ref.name) + '</span>';
      });
    }
    msgCol.innerHTML = badges + formatCommitMessage(commit.message);

    // Attach context menu and double-click to ref badges
    msgCol.querySelectorAll('.ref-badge').forEach(badge => {
      const refName = badge.textContent;
      const refType = badge.className.includes('ref-head') ? 'head'
                    : badge.className.includes('ref-remote') ? 'remote'
                    : badge.className.includes('ref-tag') ? 'tag'
                    : badge.className.includes('ref-stash') ? 'stash' : 'local';
      badge.style.cursor = 'pointer';
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

    const authorCol = document.createElement('div');
    authorCol.className = 'col-author';
    authorCol.textContent = (isVirtual || isStash) ? '' : commit.author;

    const dateCol = document.createElement('div');
    dateCol.className = 'col-date';
    dateCol.textContent = isVirtual ? 'now' : isStash ? '' : formatDate(commit.commitDate);

    const hashCol = document.createElement('div');
    hashCol.className = 'col-hash';
    hashCol.textContent = isVirtual ? '...' : isStash ? '' : commit.hash.substring(0, 7);

    row.appendChild(graphCol);
    row.appendChild(msgCol);
    row.appendChild(authorCol);
    row.appendChild(dateCol);
    row.appendChild(hashCol);

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
}

function selectCommit(hash) {
  // Deselect previous
  document.querySelectorAll('.commit-row.selected').forEach(el => el.classList.remove('selected'));

  if (state.selectedCommit === hash) {
    state.selectedCommit = null;
    state.expandedCommit = null;
    document.getElementById('detail-panel').classList.add('hidden');
    return;
  }

  state.selectedCommit = hash;
  state.expandedCommit = hash;
  const row = document.querySelector('[data-hash="' + CSS.escape(hash) + '"]');
  if (row) row.classList.add('selected');

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

function renderFileListHtml(files, hash, parentHash, section) {
  if (state.fileViewMode === 'tree') {
    return renderFileTree(buildFileTree(files), 0, hash, parentHash, section);
  }
  return files.map(f =>
    '<div class="file-item file-clickable" data-path="' + escHtml(f.path) + '" data-hash="' + escHtml(hash) + '" data-parent="' + escHtml(parentHash || '') + '">' +
      '<span class="file-status file-status-' + escHtml(f.status) + '">' + escHtml(f.status) + '</span>' +
      '<span class="file-name">' + escHtml(f.path) + '</span>' +
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
  const u = state.uncommitted;
  if (!u) { panel.classList.add('hidden'); return; }
  let html = '<h3>Uncommitted Changes</h3>';
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
  html += '</div>';
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
function renderDetailPanel(detail) {
  state._lastDetail = detail;
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  let html = '<h3>Commit Details</h3>';
  html += '<div class="detail-field"><span class="label">Hash:</span> ' + escHtml(detail.hash) + '</div>';
  html += '<div class="detail-field"><span class="label">Author:</span> ' + escHtml(detail.author) + ' &lt;' + escHtml(detail.authorEmail) + '&gt;</div>';
  html += '<div class="detail-field"><span class="label">Date:</span> ' + new Date(detail.authorDate * 1000).toLocaleString() + '</div>';
  if (detail.committer !== detail.author) {
    html += '<div class="detail-field"><span class="label">Committer:</span> ' + escHtml(detail.committer) + ' &lt;' + escHtml(detail.committerEmail) + '&gt;</div>';
  }
  if (detail.parents.length > 0) {
    html += '<div class="detail-field"><span class="label">Parents:</span> ' + detail.parents.map(p => escHtml(p.substring(0, 7))).join(', ') + '</div>';
  }
  html += '<div class="detail-message">' + escHtml(detail.message) + '</div>';

  if (detail.fileChanges && detail.fileChanges.length > 0) {
    html += '<div class="file-list">' + fileViewToggleHtml() + '<strong>Files changed (' + detail.fileChanges.length + '):</strong>';
    html += renderFileListHtml(detail.fileChanges, detail.hash, detail.parents[0] || '');
    html += '</div>';
  }

  panel.innerHTML = html;
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
function formatCommitMessage(msg) {
  let safe = escHtml(msg);
  // Apply issue linking rules from settings
  const rules = state.settings.issueLinkingRules || [];
  for (const rule of rules) {
    if (!rule.pattern) continue;
    if (rule.pattern.length > 200) continue; // ReDoS guard
    try {
      const re = new RegExp(rule.pattern, 'g');
      if (rule.url) {
        safe = safe.replace(re, function(match) {
          let href = rule.url;
          for (let i = 1; i < arguments.length - 2; i++) {
            if (typeof arguments[i] === 'string') href = href.split('$' + i).join(arguments[i]);
          }
          return '<a class="commit-link" href="' + escHtml(href) + '" target="_blank" title="' + escHtml(href) + '">' + match + '</a>';
        });
      } else {
        safe = safe.replace(re, '<span class="commit-link" title="$&">$&</span>');
      }
    } catch (e) { /* invalid regex — skip */ }
  }
  // Short commit hashes
  safe = safe.replace(/\\b([0-9a-f]{7,40})\\b/g, '<span class="commit-link" title="$1">$1</span>');
  // URLs — skip if already inside an <a> tag
  safe = safe.replace(/(<a[^>]*>.*?<\\/a>)|(https?:\\/\\/[^\\s<]+)/g, (m, linked, url) => {
    if (linked) return linked;
    return '<a class="commit-link" href="' + url + '" target="_blank">' + url + '</a>';
  });
  return safe;
}

// --- Find widget ---
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');

document.getElementById('btn-find').addEventListener('click', toggleFind);

function toggleFind() {
  findBar.classList.toggle('hidden');
  if (!findBar.classList.contains('hidden')) findInput.focus();
  else clearSearch();
}

findInput.addEventListener('input', () => doSearch(findInput.value));
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
  state.searchMatches = [];
  state.searchIndex = -1;
  findInput.value = '';
  document.getElementById('find-count').textContent = '';
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
