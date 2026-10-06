/**
 * The Git Graph script's graph: the lane layout (a port of vscode-git-graph's
 * graph.ts), the SVG it draws over the list, and the graph column — its width,
 * its cap, dragging it wider and panning what does not fit.
 *
 * Part of one shared script; see webview-script-core.ts for the rules.
 */
export function graphScript(): string {
  return String.raw`
// --- Lanes ---
/*
 * The checked-out branch is always the accent, whichever colour index the
 * layout happened to give it; the other lanes cycle through four hues that are
 * never a status colour. Set through style, not attributes: a presentation
 * attribute cannot hold var().
 */
function laneVar(colour) {
  let k = colour;
  if (gHeadColour > 0) {
    if (k === gHeadColour) k = 0;
    else if (k === 0) k = gHeadColour;
  }
  return 'var(--ln-' + (k === 0 ? 0 : 1 + ((k - 1) % 4)) + ')';
}

function svgEl(tag, attrs, style) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  if (style) for (const k in style) el.style[k] = style[k];
  return el;
}

// --- Graph layout (faithful port of vscode-git-graph graph.ts) ---

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

  draw(svg, config) {
    const colour = this._isStash ? 'var(--ln-5)' : laneVar(this._colour);
    const d = config.grid.y * (config.style === 'angular' ? 0.38 : 0.8);
    const pxLines = [];
    let curPath = '';

    for (let i = 0; i < this._lines.length; i++) {
      const ln = this._lines[i];
      const x1 = ln.p1.x * config.grid.x + config.grid.offsetX;
      const y1 = ln.p1.y * config.grid.y + config.grid.offsetY;
      const x2 = ln.p2.x * config.grid.x + config.grid.offsetX;
      const y2 = ln.p2.y * config.grid.y + config.grid.offsetY;
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

    for (let i = 0; i < pxLines.length; i++) {
      const pl = pxLines[i];
      const x1 = pl.p1.x, y1 = pl.p1.y, x2 = pl.p2.x, y2 = pl.p2.y;

      if (curPath !== '' && i > 0 && pl.isC !== pxLines[i - 1].isC) {
        GBranch._drawPath(svg, curPath, pxLines[i - 1].isC && !this._isStash, colour);
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
    if (curPath !== '') GBranch._drawPath(svg, curPath, pxLines[pxLines.length - 1].isC && !this._isStash, colour);
  }

  /** A stash's lane and the line from uncommitted changes are drawn dashed. */
  static _drawPath(svg, path, solid, colour) {
    svg.appendChild(svgEl('path', { class: solid ? 'line' : 'line dash', d: path }, { stroke: colour }));
  }
}

class GVertex {
  constructor(id, isStash, isWip) {
    this.id = id;
    this.isStash = !!isStash;
    this.isWip = !!isWip;
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
   * One shape per kind of row, so the graph can be read without the list:
   * a filled dot for a commit, a ring for a merge, a ringed dot for the
   * checked-out commit, a dashed ring for uncommitted changes and a diamond
   * for a stash. Every shape sits on a disc of the background colour, which is
   * what cuts the lines passing behind it.
   */
  draw(svg, config) {
    if (this._onBranch === null) return;
    const cx = this._x * config.grid.x + config.grid.offsetX;
    const cy = this.id * config.grid.y + config.grid.offsetY;
    const lane = this.isStash ? 'var(--ln-5)' : laneVar(this._onBranch.getColour());
    const bg = 'var(--bg)';
    const kind = this.isWip ? 'wip' : this.isStash ? 'stash' : this._isCurrent ? 'head' : this.isMerge() ? 'merge' : 'commit';
    const g = svgEl('g', { class: 'node node-' + kind, 'data-id': this.id });
    if (kind === 'commit') {
      g.appendChild(svgEl('circle', { cx, cy, r: 5.5, 'stroke-width': 2 }, { fill: lane, stroke: bg }));
    } else if (kind === 'merge') {
      g.appendChild(svgEl('circle', { cx, cy, r: 5.5 }, { fill: bg }));
      g.appendChild(svgEl('circle', { cx, cy, r: 3.5, 'stroke-width': 2 }, { fill: bg, stroke: lane }));
    } else if (kind === 'head') {
      g.appendChild(svgEl('circle', { cx, cy, r: 7.5 }, { fill: bg }));
      g.appendChild(svgEl('circle', { cx, cy, r: 5.5, 'stroke-width': 2 }, { fill: bg, stroke: lane }));
      g.appendChild(svgEl('circle', { cx, cy, r: 2.5 }, { fill: lane }));
    } else if (kind === 'wip') {
      g.appendChild(svgEl('circle', { cx, cy, r: 6.5 }, { fill: bg }));
      g.appendChild(svgEl('circle', { cx, cy, r: 4.75, 'stroke-width': 1.5, 'stroke-dasharray': '2.2 1.8' }, { fill: bg, stroke: lane }));
    } else {
      const diamond = (r) => 'M' + cx + ',' + (cy - r) + 'L' + (cx + r) + ',' + cy + 'L' + cx + ',' + (cy + r) + 'L' + (cx - r) + ',' + cy + 'Z';
      g.appendChild(svgEl('path', { d: diamond(7.5) }, { fill: bg }));
      g.appendChild(svgEl('path', { d: diamond(5), 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, { fill: bg, stroke: lane }));
    }
    svg.appendChild(g);
  }
}

function graphLoadCommits(commits) {
  gVertices = []; gBranches = []; gAvailColours = []; gHeadColour = 0;
  if (commits.length === 0) return;

  const nullVertex = new GVertex(NULL_VERTEX_ID, false, false);
  const lookup = {};
  for (let i = 0; i < commits.length; i++) {
    lookup[commits[i].hash] = i;
    gVertices.push(new GVertex(i, !!commits[i]._isStash, !!commits[i]._isWip));
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
  if (commits[0] && commits[0]._isWip) gVertices[0].setNotCommitted();

  let i = 0;
  while (i < gVertices.length) {
    if (gVertices[i].getNextParent() !== null || gVertices[i].isNotOnBranch()) {
      graphDeterminePath(i);
    } else { i++; }
  }
  if (state.head && typeof lookup[state.head] === 'number') {
    gHeadColour = gVertices[lookup[state.head]].getColour();
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

/** The height a list row really has right now — fractional under browser zoom. */
function measuredRowHeight() {
  const firstRow = document.querySelector('#commit-list .commit-row');
  return firstRow ? firstRow.getBoundingClientRect().height : 0;
}

function graphRender() {
  const container = document.getElementById('graph-svg-container');
  container.innerHTML = '';
  if (gVertices.length === 0) { state.graphWidth = GRAPH_MIN_W; state.renderedRowH = 0; applyGraphColWidth(); return; }

  // Measured, and the grid uses it as is, so that a fractional row height under
  // zoom does not drift the nodes off their rows by the bottom of the list.
  const rowH = measuredRowHeight() || graphConfig.grid.y;
  state.renderedRowH = rowH;
  const cfg = { ...graphConfig, grid: { ...graphConfig.grid, y: rowH, offsetY: rowH / 2 } };

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const lines = document.createElementNS(SVG_NS, 'g');
  const nodes = document.createElementNS(SVG_NS, 'g');
  for (let i = 0; i < gBranches.length; i++) gBranches[i].draw(lines, cfg);
  for (let i = 0; i < gVertices.length; i++) gVertices[i].draw(nodes, cfg);
  svg.appendChild(lines);
  svg.appendChild(nodes);

  let maxX = 0;
  for (let i = 0; i < gVertices.length; i++) {
    const p = gVertices[i].getNextPoint();
    if (p.x > maxX) maxX = p.x;
  }
  const w = Math.max(64, 28 + Math.max(maxX - 1, 0) * cfg.grid.x);
  const h = gVertices.length * cfg.grid.y;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  container.appendChild(svg);
  // The SVG is drawn at the width the lanes need; the column it shows through
  // is a different number entirely, and the panel decides that one.
  state.graphWidth = w;
  applyGraphColWidth();
}

/** Redraw when the rows changed height under the graph: a breakpoint, a zoom. */
function rerenderGraphIfRowHeightChanged() {
  const h = measuredRowHeight();
  if (h && Math.abs(h - state.renderedRowH) > 0.01) graphRender();
}

/*
 * The widest the graph column may be right now: whatever is left of the panel
 * once the columns that cannot shrink have taken theirs, the gaps between the
 * cells have theirs, and the message has its floor. Measured from the header
 * rather than from a table of constants, so hiding a column — by the user's
 * choice or by a width tier — gives its pixels to the graph without anything
 * here having to know which columns exist.
 */
function graphColCap() {
  const header = document.getElementById('graph-header');
  const area = document.getElementById('graph-container');
  if (!header || !area || !area.clientWidth) return MESSAGE_MIN_W;
  let fixed = 0;
  let shown = 0;
  // offsetWidth is 0 for a hidden column, which is exactly the answer wanted.
  header.querySelectorAll('.col-changes, .col-author, .col-date, .col-hash')
    .forEach((cell) => { fixed += cell.offsetWidth; if (cell.offsetWidth) shown++; });
  const rowPadding = ROW_PAD + ROW_GAP * (shown + 1);
  return Math.max(GRAPH_MIN_W, area.clientWidth - fixed - rowPadding - MESSAGE_MIN_W);
}

/**
 * Publish the graph column's width: the dragged one if there is one, else what
 * the lanes need, both capped to what the panel can spare.
 */
function applyGraphColWidth() {
  const cap = graphColCap();
  const want = state.graphColWidth === null ? state.graphWidth : state.graphColWidth;
  const width = Math.max(GRAPH_MIN_W, Math.min(want || GRAPH_MIN_W, cap));
  document.documentElement.style.setProperty('--graph-col-w', width + 'px');
  applyGraphPan();
}

/** How far the graph can be moved: what is drawn, less what the column shows. */
function graphPanMax() {
  const cell = document.querySelector('#graph-header .col-graph');
  return Math.max(0, state.graphWidth - (cell ? cell.offsetWidth : 0));
}

/**
 * Move the overlay inside its clip box, and put the hint where the column now
 * is. The hint is not a scrollbar: it takes no room in the table and is only
 * legible while something is moving the graph.
 */
function applyGraphPan() {
  const cell = document.querySelector('#graph-header .col-graph');
  const shown = cell ? cell.offsetWidth : 0;
  const max = graphPanMax();
  state.graphPanX = Math.min(Math.max(0, state.graphPanX), max);
  document.documentElement.style.setProperty('--graph-pan-x', state.graphPanX + 'px');
  document.documentElement.classList.toggle('graph-can-pan', max > 0);

  const bar = document.getElementById('graph-pan-bar');
  const thumb = document.getElementById('graph-pan-thumb');
  if (!bar || !thumb) return;
  bar.classList.toggle('hidden', max <= 0 || !state.graphWidth);
  if (max <= 0 || !state.graphWidth) return;
  const ratio = shown / state.graphWidth;
  thumb.style.width = (ratio * 100) + '%';
  thumb.style.left = ((state.graphPanX / state.graphWidth) * 100) + '%';
}

/** Show the hint while something is moving the graph, then let it fade. */
function showPanHint(sticky) {
  const bar = document.getElementById('graph-pan-bar');
  if (!bar || bar.classList.contains('hidden')) return;
  bar.classList.add('visible');
  if (panHintTimer) clearTimeout(panHintTimer);
  panHintTimer = sticky ? null : setTimeout(() => bar.classList.remove('visible'), 700);
}

function panGraphBy(dx) {
  state.graphPanX += dx;
  applyGraphPan();
  showPanHint(false);
}

// --- Graph column resize ---
{
  const resizeHandle = document.getElementById('graph-resize-handle');
  let resizing = false, startX = 0, startW = 0;
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizing = true;
    startX = e.clientX;
    startW = document.querySelector('#graph-header .col-graph').offsetWidth;
    resizeHandle.classList.add('dragging');
    resizeHandle.setPointerCapture(e.pointerId);
  });
  // Both ends of the drag go through the same cap the automatic width uses: a
  // hand-dragged column wider than the panel is the bug this whole path is
  // about, and a ceiling of its own would also be a ceiling the automatic width
  // could exceed and the drag could then never restore.
  const dragTo = (e) => {
    state.graphColWidth = Math.max(GRAPH_MIN_W, startW + e.clientX - startX);
    applyGraphColWidth();
  };
  resizeHandle.addEventListener('pointermove', (e) => { if (resizing) dragTo(e); });
  resizeHandle.addEventListener('pointerup', (e) => {
    if (!resizing) return;
    resizing = false;
    resizeHandle.classList.remove('dragging');
    dragTo(e);
  });
  resizeHandle.addEventListener('dblclick', () => {
    state.graphColWidth = null;
    applyGraphColWidth();
  });
}

// --- Panning the graph inside its column ---
{
  const list = document.getElementById('commit-list');
  let tracking = false, panned = false, startX = 0, startY = 0, startPan = 0, pointerId = null;

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.target.closest || !e.target.closest('.col-graph')) return;
    if (graphPanMax() <= 0) return;
    tracking = true;
    panned = false;
    startX = e.clientX;
    startY = e.clientY;
    startPan = state.graphPanX;
    pointerId = e.pointerId;
  });

  list.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const dx = e.clientX - startX;
    if (!panned) {
      // Sideways and past the slop before this is a pan: anything else is the
      // press that selects a commit, or the finger that scrolls the list —
      // .col-graph is touch-action: pan-y so the browser keeps that one.
      if (Math.abs(dx) < 4 || Math.abs(dx) <= Math.abs(e.clientY - startY)) return;
      panned = true;
      list.setPointerCapture(pointerId);
      document.documentElement.classList.add('graph-panning');
      showPanHint(true);
    }
    state.graphPanX = startPan - dx;
    applyGraphPan();
  });

  const endPan = () => {
    if (!tracking) return;
    tracking = false;
    if (!panned) return;
    try { list.releasePointerCapture(pointerId); } catch (err) { /* already released */ }
    document.documentElement.classList.remove('graph-panning');
    showPanHint(false);
  };
  list.addEventListener('pointerup', endPan);
  list.addEventListener('pointercancel', endPan);
  // A drag is not a click. Captured on the way down, because the row's own
  // handler would otherwise open the commit the pan happened to end on.
  list.addEventListener('click', (e) => {
    if (!panned) return;
    panned = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  // A trackpad's sideways gesture and shift+wheel, over the list itself. The
  // overlay cannot take these: it is pointer-events: none so that a click lands
  // on the row underneath it.
  document.getElementById('graph-container').addEventListener('wheel', (e) => {
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    if (!dx || (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY))) return;
    const before = state.graphPanX;
    panGraphBy(dx);
    if (state.graphPanX !== before) e.preventDefault();
  }, { passive: false });
  // The cap is a share of the panel's width, so it is only right until the
  // panel changes size — and nothing re-renders the graph when a window is
  // dragged or the inspector opens beside the list.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => applyGraphColWidth()).observe(document.getElementById('graph-container'));
  }
  // The row height is per breakpoint and per pointer, and the graph is drawn
  // for one height.
  window.addEventListener('resize', rerenderGraphIfRowHeightChanged);
}

// --- Columns the reader chose to see ---
function applyColumnVisibility() {
  const root = document.documentElement;
  OPTIONAL_COLUMNS.forEach((col) => {
    root.classList.toggle(col.cls, state.settings[col.key] === false);
  });
  // Hiding a column hands its width to the graph, and no resize fires for it.
  applyGraphColWidth();
}

/**
 * Whether a column is hidden by the list's width whatever the setting says.
 * The tiers are container queries on the list, so this measures the list
 * rather than the window — an open inspector narrows one and not the other.
 * The menu marks those rather than hiding them, so that a tick doing nothing
 * is never the only explanation on offer.
 */
function columnBlockedByWidth(key) {
  const area = document.getElementById('graph-container');
  const w = area ? area.clientWidth : 0;
  if (!w) return false;
  if (key === 'colHash') return w <= 900;
  if (key === 'colChanges') return w <= 600;
  return false;
}

function setColumnVisible(key, visible) {
  state.settings[key] = visible;
  vscode.postMessage({ command: 'updateSetting', key, value: visible });
  applyColumnVisibility();
  const box = document.getElementById('s-' + key);
  if (box) box.checked = visible;
}

function columnMenuItems() {
  return OPTIONAL_COLUMNS.map((col) => ({
    label: col.label + (columnBlockedByWidth(col.key) ? ' — needs a wider panel' : ''),
    checked: state.settings[col.key] !== false,
    disabled: columnBlockedByWidth(col.key),
    action: () => setColumnVisible(col.key, state.settings[col.key] === false),
  }));
}

function showColumnMenu(x, y) {
  openMenu([{ heading: 'Columns' }].concat(columnMenuItems()), { x, y });
}

{
  const header = document.getElementById('graph-header');
  header.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showColumnMenu(e.clientX, e.clientY);
  });
  setupLongPress(header, (x, y) => showColumnMenu(x, y));
}
`;
}
