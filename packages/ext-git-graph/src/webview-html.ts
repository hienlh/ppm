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
        <button id="btn-settings" title="Settings">&#x2699;</button>
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
      <div id="commit-list-wrapper">
        <div id="graph-svg-container"></div>
        <div id="commit-list"></div>
      </div>
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
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #09090b; --surface: #18181b; --text: #fafafa; --subtext: #a1a1aa; --subtle: #52525b;
    --border: #27272a; --border2: #3f3f46; --selected: #1e293b; --surface-hover: #27272a;
  }
  #graph-svg-container .shadow { stroke: rgba(255,255,255,0.08); }
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
.col-graph { width: var(--graph-col-w, 120px); min-width: var(--graph-col-w, 80px); overflow: hidden; flex-shrink: 0; }
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

/* SVG graph — single SVG overlay */
#commit-list-wrapper { position: relative; }
#graph-svg-container { position: absolute; top: 0; left: 8px; z-index: 1; pointer-events: none; }
#graph-svg-container circle { pointer-events: auto; cursor: pointer; }
#graph-svg-container .shadow { stroke: rgba(0,0,0,0.15); stroke-width: 5; fill: none; }
#graph-svg-container .line { stroke-width: 2; fill: none; }
#graph-svg-container .graphCurrent { fill: var(--bg); stroke-width: 2; }
#graph-svg-container .graphStashOuter { fill: none; stroke: #808080; stroke-width: 1.5; }
#graph-svg-container .graphStashInner { fill: #808080; }
.commit-row.graph-hover { background: var(--surface-hover); }

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
const SVG_NS = 'http://www.w3.org/2000/svg';
const NULL_VERTEX_ID = -1;
const GRAPH_COLORS = ['#4ec9b0','#569cd6','#c586c0','#ce9178','#dcdcaa','#4fc1ff','#d7ba7d','#9cdcfe','#b5cea8','#d16969'];
const graphConfig = {
  colours: GRAPH_COLORS,
  grid: { x: 16, y: 28, offsetX: 8, offsetY: 14, expandY: 60 },
  style: 'rounded'
};

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

// --- Graph rendering (faithful port of vscode-git-graph graph.ts) ---

class GBranch {
  constructor(colour) {
    this._colour = colour;
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
    const colour = config.colours[this._colour % config.colours.length];
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
    const shadow = document.createElementNS(SVG_NS, 'path');
    const line = document.createElementNS(SVG_NS, 'path');
    shadow.setAttribute('class', 'shadow');
    shadow.setAttribute('d', path);
    line.setAttribute('class', 'line');
    line.setAttribute('d', path);
    line.setAttribute('stroke', isCommitted ? colour : '#808080');
    if (!isCommitted) line.setAttribute('stroke-dasharray', '2');
    svg.appendChild(shadow);
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
    const colour = this._isCommitted ? config.colours[this._onBranch.getColour() % config.colours.length] : '#808080';
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

    if (this.isStash && !this._isCurrent) {
      circle.setAttribute('r', '4.5');
      circle.setAttribute('class', 'graphStashOuter');
      const inner = document.createElementNS(SVG_NS, 'circle');
      inner.setAttribute('cx', cx);
      inner.setAttribute('cy', cy);
      inner.setAttribute('r', '2');
      inner.setAttribute('class', 'graphStashInner');
      svg.appendChild(inner);
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

  const stashHashes = new Set(state.stashes.map(s => s.hash));
  const nullVertex = new GVertex(NULL_VERTEX_ID, false);
  const lookup = {};
  for (let i = 0; i < commits.length; i++) {
    lookup[commits[i].hash] = i;
    gVertices.push(new GVertex(i, stashHashes.has(commits[i].hash)));
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
    const branch = new GBranch(graphGetAvailableColour(startAt));
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
  if (gVertices.length === 0) { document.documentElement.style.setProperty('--graph-col-w', '40px'); return; }

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
  document.documentElement.style.setProperty('--graph-col-w', gw + 'px');
}

function graphVertexOver(e) {
  if (!e.target || !e.target.dataset || !e.target.dataset.id) return;
  const id = parseInt(e.target.dataset.id);
  if (id >= 0 && id < state.commits.length) {
    const rows = document.querySelectorAll('.commit-row:not(.header-row)');
    if (rows[id]) rows[id].classList.add('graph-hover');
    e.target.setAttribute('r', e.target.classList.contains('graphStashOuter') ? '5.5' : '5');
  }
}
function graphVertexOut(e) {
  if (!e.target || !e.target.dataset || !e.target.dataset.id) return;
  const id = parseInt(e.target.dataset.id);
  if (id >= 0) {
    const rows = document.querySelectorAll('.commit-row:not(.header-row)');
    if (rows[id]) rows[id].classList.remove('graph-hover');
    e.target.setAttribute('r', e.target.classList.contains('graphStashOuter') ? '4.5' : '4');
  }
}

// --- Commit list ---
function renderCommitList() {
  const container = document.getElementById('commit-list');
  container.innerHTML = '';

  graphLoadCommits(state.commits);

  state.commits.forEach((commit, idx) => {
    const row = document.createElement('div');
    row.className = 'commit-row';
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
        badges += '<span class="ref-badge ref-' + ref.type + '">' + escHtml(ref.name) + '</span>';
      });
    }
    msgCol.innerHTML = badges + formatCommitMessage(commit.message);

    const authorCol = document.createElement('div');
    authorCol.className = 'col-author';
    authorCol.textContent = commit.author;

    const dateCol = document.createElement('div');
    dateCol.className = 'col-date';
    dateCol.textContent = formatRelativeDate(commit.commitDate);

    const hashCol = document.createElement('div');
    hashCol.className = 'col-hash';
    hashCol.textContent = commit.hash.substring(0, 7);

    row.appendChild(graphCol);
    row.appendChild(msgCol);
    row.appendChild(authorCol);
    row.appendChild(dateCol);
    row.appendChild(hashCol);

    row.addEventListener('click', () => selectCommit(commit.hash));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCommitContextMenu(e.clientX, e.clientY, commit);
    });
    setupLongPress(row, (x, y) => showCommitContextMenu(x, y, commit));

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
    html += '<div class="detail-field"><span class="label">Parents:</span> ' + detail.parents.map(p => escHtml(p.substring(0, 7))).join(', ') + '</div>';
  }
  html += '<div class="detail-message">' + escHtml(detail.message) + '</div>';

  if (detail.fileChanges && detail.fileChanges.length > 0) {
    html += '<div class="file-list"><strong>Files changed (' + detail.fileChanges.length + '):</strong>';
    detail.fileChanges.forEach(f => {
      html += '<div class="file-item">';
      html += '<span class="file-status file-status-' + escHtml(f.status) + '">' + escHtml(f.status) + '</span>';
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
  // Short commit hashes first (before URLs, to avoid matching hex in href attributes)
  safe = safe.replace(/\\b([0-9a-f]{7,40})\\b/g, '<span class="commit-link" title="$1">$1</span>');
  // Issue references (#123)
  safe = safe.replace(/#(\\d+)/g, '<span class="commit-link" title="Issue #$1">#$1</span>');
  // URLs last (won't corrupt already-wrapped hashes since they don't look like URLs)
  safe = safe.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a class="commit-link" href="$1" target="_blank">$1</a>');
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

// --- Settings panel ---
document.getElementById('btn-settings').addEventListener('click', () => {
  showDialog({
    title: 'Git Graph Settings',
    message: 'Max commits to load per page:',
    input: { placeholder: 'e.g. 300', defaultValue: String(state.maxCommits) },
    confirmLabel: 'Save',
    onConfirm: (value) => {
      const n = parseInt(value, 10);
      if (n > 0 && n <= 10000) state.maxCommits = n;
    }
  });
});
`;
}
