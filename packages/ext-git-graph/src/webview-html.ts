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
        <select id="branch-selector"><option value="all">All Branches</option></select>
        <button id="btn-refresh" title="Refresh">&#x21bb;</button>
      </div>
      <div class="toolbar-right">
        <button id="btn-find" title="Find (Ctrl+F)">&#x1F50D;</button>
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
        <div class="col-graph">Graph</div>
        <div class="col-message">Message</div>
        <div class="col-author">Author</div>
        <div class="col-date">Date</div>
        <div class="col-hash">Hash</div>
      </div>
      <div id="commit-list"></div>
      <div id="loading" class="loading hidden">Loading...</div>
    </div>
    <div id="detail-panel" class="detail-panel hidden"></div>
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
  --graph-colors: #4ec9b0, #569cd6, #c586c0, #ce9178, #dcdcaa, #4fc1ff, #d7ba7d, #9cdcfe, #b5cea8, #d16969;
  --cell-w: 16; --cell-h: 24;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b; --surface: #18181b; --text: #fafafa; --subtext: #a1a1aa; --subtle: #52525b;
    --border: #27272a; --border2: #3f3f46; --selected: #1e293b; --surface-hover: #27272a;
  }
}
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); font-size: 13px; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
#app { display: flex; flex-direction: column; height: 100vh; }

/* Toolbar */
#toolbar { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; }
select { background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 4px 8px; font-size: 12px; }
button { background: transparent; color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer; min-width: 28px; min-height: 28px; }
button:hover { background: var(--surface-hover); }

/* Find bar */
.find-bar { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface); }
.find-bar input { flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 4px 8px; font-size: 12px; }
.find-bar input:focus { outline: none; border-color: var(--blue); }
#find-count { font-size: 11px; color: var(--subtext); min-width: 60px; }
.hidden { display: none !important; }

/* Graph container */
#graph-container { flex: 1; overflow-y: auto; overflow-x: hidden; }
.commit-row { display: flex; align-items: center; border-bottom: 1px solid var(--border); cursor: pointer; min-height: 28px; padding: 0 8px; }
.commit-row:hover { background: var(--surface-hover); }
.commit-row.selected { background: var(--selected); }
.commit-row.header-row { background: var(--surface); cursor: default; font-weight: 600; font-size: 11px; color: var(--subtext); text-transform: uppercase; letter-spacing: 0.5px; position: sticky; top: 0; z-index: 2; }
.commit-row.search-match { background: rgba(234, 179, 8, 0.15); }
.col-graph { width: 120px; min-width: 120px; overflow: hidden; position: relative; height: 28px; }
.col-message { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px; }
.col-author { width: 120px; min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--subtext); font-size: 12px; }
.col-date { width: 100px; min-width: 100px; color: var(--subtext); font-size: 12px; }
.col-hash { width: 70px; min-width: 70px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--subtle); }

/* Ref badges */
.ref-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-right: 4px; vertical-align: middle; }
.ref-head { background: var(--green); color: #fff; }
.ref-local { background: var(--blue); color: #fff; }
.ref-remote { background: var(--purple); color: #fff; }
.ref-tag { background: var(--yellow); color: #000; }

/* SVG graph */
.graph-svg { position: absolute; top: 0; left: 0; }
.graph-node { stroke-width: 2; }
.graph-line { fill: none; stroke-width: 2; }

/* Detail panel */
.detail-panel { border-top: 1px solid var(--border2); background: var(--surface); max-height: 40vh; overflow-y: auto; padding: 12px 16px; flex-shrink: 0; }
.detail-panel h3 { font-size: 14px; margin-bottom: 8px; }
.detail-field { margin-bottom: 4px; font-size: 12px; }
.detail-field .label { color: var(--subtext); display: inline-block; width: 80px; }
.detail-message { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; margin: 8px 0; font-size: 12px; white-space: pre-wrap; font-family: 'SF Mono', 'Fira Code', monospace; }
.file-list { margin-top: 8px; }
.file-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; }
.file-status { display: inline-block; width: 16px; text-align: center; font-weight: 700; font-size: 11px; }
.file-status-A { color: var(--green); }
.file-status-M { color: var(--yellow); }
.file-status-D { color: var(--red); }
.file-status-R { color: var(--blue); }
.file-stat { color: var(--subtext); font-size: 11px; margin-left: auto; }
.file-stat .add { color: var(--green); }
.file-stat .del { color: var(--red); }

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
.dialog-actions .btn-primary { background: var(--blue); color: #fff; }
.dialog-actions .btn-danger { background: var(--red); color: #fff; }

/* Links in commit messages */
.commit-link { color: var(--blue); text-decoration: none; cursor: pointer; }
.commit-link:hover { text-decoration: underline; }

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
const GRAPH_COLORS = ['#4ec9b0','#569cd6','#c586c0','#ce9178','#dcdcaa','#4fc1ff','#d7ba7d','#9cdcfe','#b5cea8','#d16969'];
const CELL_W = 16;
const CELL_H = 28;

// --- State ---
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
  searchMatches: [],
  searchIndex: -1,
};

// --- Init ---
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
    case 'actionResult':
      if (!msg.result.ok) alert('Git action failed: ' + (msg.result.error || 'Unknown error'));
      break;
    case 'error':
      document.getElementById('status-text').textContent = 'Error: ' + msg.message;
      break;
  }
});

// --- Branch selector ---
function renderBranchSelector() {
  const sel = document.getElementById('branch-selector');
  sel.innerHTML = '<option value="all">All Branches</option>';
  state.branches.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.name;
    opt.textContent = (b.current ? '* ' : '') + b.name;
    sel.appendChild(opt);
  });
}

document.getElementById('branch-selector').addEventListener('change', (e) => {
  const branch = e.target.value;
  state.commits = [];
  document.getElementById('commit-list').innerHTML = '';
  vscode.postMessage({ command: 'requestCommits', branch, maxCommits: state.maxCommits });
});

// --- Refresh ---
document.getElementById('btn-refresh').addEventListener('click', () => {
  state.commits = [];
  document.getElementById('commit-list').innerHTML = '';
  vscode.postMessage({ command: 'requestRepoInfo' });
  vscode.postMessage({ command: 'requestCommits', maxCommits: state.maxCommits });
});

// --- Graph rendering ---
function assignLanes(commits) {
  const lanes = []; // active lane → hash of branch tip
  const commitLane = new Map();

  for (const commit of commits) {
    // Find existing lane for this commit
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      // New branch — find empty lane or add new one
      lane = lanes.indexOf(null);
      if (lane === -1) { lane = lanes.length; lanes.push(null); }
    }
    commitLane.set(commit.hash, lane);
    lanes[lane] = null; // Free lane after commit

    // Assign parents to lanes
    for (let i = 0; i < commit.parents.length; i++) {
      const parentHash = commit.parents[i];
      const existingLane = lanes.indexOf(parentHash);
      if (existingLane !== -1) continue; // Already has a lane

      if (i === 0) {
        // First parent stays in same lane
        lanes[lane] = parentHash;
      } else {
        // Other parents get new lanes
        const emptyLane = lanes.indexOf(null);
        if (emptyLane !== -1) lanes[emptyLane] = parentHash;
        else lanes.push(parentHash);
      }
    }
  }
  return commitLane;
}

function renderGraphSvg(commit, row, commitLane, allCommits) {
  const lane = commitLane.get(commit.hash) || 0;
  const cx = lane * CELL_W + CELL_W / 2;
  const cy = CELL_H / 2;
  const color = GRAPH_COLORS[lane % GRAPH_COLORS.length];

  let svg = '<svg class="graph-svg" width="' + Math.max((lane + 3) * CELL_W, 120) + '" height="' + CELL_H + '">';

  // Draw lines to parents
  for (const parentHash of commit.parents) {
    const parentIdx = allCommits.findIndex(c => c.hash === parentHash);
    if (parentIdx === -1) continue;
    const parentLane = commitLane.get(parentHash) || 0;
    const px = parentLane * CELL_W + CELL_W / 2;
    const py = CELL_H; // Bottom of cell = top of next row
    const pColor = GRAPH_COLORS[parentLane % GRAPH_COLORS.length];

    if (lane === parentLane) {
      // Straight vertical line
      svg += '<line x1="' + cx + '" y1="' + cy + '" x2="' + px + '" y2="' + py + '" stroke="' + pColor + '" class="graph-line" />';
    } else {
      // Bezier curve for lane change
      const midY = cy + (py - cy) / 2;
      svg += '<path d="M' + cx + ' ' + cy + ' C' + cx + ' ' + midY + ' ' + px + ' ' + midY + ' ' + px + ' ' + py + '" stroke="' + pColor + '" class="graph-line" />';
    }
  }

  // Draw commit node
  svg += '<circle cx="' + cx + '" cy="' + cy + '" r="4" fill="' + color + '" stroke="' + color + '" class="graph-node" />';
  svg += '</svg>';
  return svg;
}

// --- Commit list ---
function renderCommitList() {
  const container = document.getElementById('commit-list');
  container.innerHTML = '';
  const commitLane = assignLanes(state.commits);

  state.commits.forEach((commit, idx) => {
    const row = document.createElement('div');
    row.className = 'commit-row';
    row.dataset.hash = commit.hash;

    // Graph column
    const graphCol = document.createElement('div');
    graphCol.className = 'col-graph';
    graphCol.innerHTML = renderGraphSvg(commit, idx, commitLane, state.commits);

    // Message column with ref badges
    const msgCol = document.createElement('div');
    msgCol.className = 'col-message';
    let badges = '';
    if (commit.refs) {
      commit.refs.forEach(ref => {
        badges += '<span class="ref-badge ref-' + ref.type + '">' + escHtml(ref.name) + '</span>';
      });
    }
    msgCol.innerHTML = badges + formatCommitMessage(commit.message);

    // Author column
    const authorCol = document.createElement('div');
    authorCol.className = 'col-author';
    authorCol.textContent = commit.author;

    // Date column
    const dateCol = document.createElement('div');
    dateCol.className = 'col-date';
    dateCol.textContent = formatRelativeDate(commit.commitDate);

    // Hash column
    const hashCol = document.createElement('div');
    hashCol.className = 'col-hash';
    hashCol.textContent = commit.hash.substring(0, 7);

    row.appendChild(graphCol);
    row.appendChild(msgCol);
    row.appendChild(authorCol);
    row.appendChild(dateCol);
    row.appendChild(hashCol);

    // Click handler
    row.addEventListener('click', () => selectCommit(commit.hash));

    // Context menu (right-click + long-press for mobile)
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCommitContextMenu(e.clientX, e.clientY, commit);
    });
    setupLongPress(row, (x, y) => showCommitContextMenu(x, y, commit));

    container.appendChild(row);
  });
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

  vscode.postMessage({ command: 'requestCommitDetails', hash });
}

// --- Detail panel ---
function renderDetailPanel(detail) {
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
    html += '<div class="detail-field"><span class="label">Parents:</span> ' + detail.parents.map(p => p.substring(0, 7)).join(', ') + '</div>';
  }
  html += '<div class="detail-message">' + escHtml(detail.message) + '</div>';

  if (detail.fileChanges && detail.fileChanges.length > 0) {
    html += '<div class="file-list"><strong>Files changed (' + detail.fileChanges.length + '):</strong>';
    detail.fileChanges.forEach(f => {
      html += '<div class="file-item">';
      html += '<span class="file-status file-status-' + f.status + '">' + f.status + '</span>';
      html += '<span>' + escHtml(f.path) + '</span>';
      html += '<span class="file-stat">';
      if (f.additions > 0) html += '<span class="add">+' + f.additions + '</span> ';
      if (f.deletions > 0) html += '<span class="del">-' + f.deletions + '</span>';
      html += '</span></div>';
    });
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
    { separator: true },
    { label: 'Cherry-pick', action: () => gitAction('cherryPick', { hash: commit.hash }) },
    { label: 'Revert', action: () => gitAction('revert', { hash: commit.hash }) },
    { separator: true },
    { label: 'Reset Current Branch to Here...', destructive: true, action: () => promptResetMode(commit.hash) },
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
  if (opts.message) dialog.innerHTML += '<p' + (opts.destructive ? ' class="warning"' : '') + '>' + escHtml(opts.message) + '</p>';

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
  cancelBtn.textContent = 'Cancel';
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
  });
  el.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('touchcancel', () => { if (timer) { clearTimeout(timer); timer = null; } });
}

// --- Text formatter (URLs, issues, commit hashes) ---
function formatCommitMessage(msg) {
  let safe = escHtml(msg);
  // URLs
  safe = safe.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a class="commit-link" href="$1" target="_blank">$1</a>');
  // Issue references (#123)
  safe = safe.replace(/#(\\d+)/g, '<span class="commit-link" title="Issue #$1">#$1</span>');
  // Short commit hashes (7+ hex chars standalone)
  safe = safe.replace(/\\b([0-9a-f]{7,40})\\b/g, '<span class="commit-link" title="$1">$1</span>');
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
  document.querySelectorAll('.commit-row:not(.header-row)').forEach((row, idx) => {
    const commit = state.commits[idx];
    if (!commit) return;
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
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function formatRelativeDate(ts) {
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
`;
}
