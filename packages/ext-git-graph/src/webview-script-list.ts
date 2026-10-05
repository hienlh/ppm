/**
 * The Git Graph script's list: which rows there are (commits, the
 * uncommitted-changes row, stashes), how each is drawn, the ref pills, the
 * lines-changed column, the scroll markers, selection and find.
 *
 * Part of one shared script; see webview-script-core.ts for the rules.
 */
export function listScript(): string {
  return String.raw`
// --- Which rows there are ---
function changedFiles() {
  return (state.changes && Array.isArray(state.changes.files)) ? state.changes.files : [];
}

/*
 * Uncommitted changes get a row of their own above the commit they sit on —
 * but only when that commit is in the list: scoped to another branch, the row
 * would hang off nothing.
 */
function showWipRow() {
  if (!changedFiles().length) return false;
  if (!state.head) return true;
  return state.commits.some((c) => c.hash === state.head);
}

function wipCommit() {
  const now = Math.floor(Date.now() / 1000);
  return {
    hash: 'uncommitted', parents: state.head ? [state.head] : [],
    author: '', authorEmail: '', authorDate: now, committer: '', committerEmail: '', commitDate: now,
    refs: [], message: 'Uncommitted changes', _isWip: true,
  };
}

/** "On main: message" → { branch: 'main', message: 'message' }. */
function stashParts(message) {
  const m = /^(?:WIP )?[Oo]n ([^:]+): ([\s\S]*)$/.exec(String(message || ''));
  return m ? { branch: m[1], message: m[2] } : { branch: null, message: String(message || '') };
}

function getDisplayCommits() {
  let commits = state.commits;
  if (showWipRow()) commits = [wipCommit()].concat(commits);

  // Stashes as spurs from the commit they were made on. A stash must come
  // BEFORE its parent: the layout scans forward to find parents.
  if (state.settings.showStashes && state.stashes.length > 0) {
    const parentIndexes = {};
    const commitHashSet = new Set(commits.map((c) => c.hash));
    for (const s of state.stashes) {
      if (!s.parentHash || !commitHashSet.has(s.parentHash)) continue;
      if (!parentIndexes[s.parentHash]) parentIndexes[s.parentHash] = [];
      parentIndexes[s.parentHash].push(s);
    }
    if (Object.keys(parentIndexes).length > 0) {
      const result = [];
      for (const c of commits) {
        const stashesForCommit = parentIndexes[c.hash];
        if (stashesForCommit) {
          for (const s of stashesForCommit) {
            result.push({
              hash: s.hash,
              parents: [s.parentHash],
              author: s.author || '', authorEmail: s.authorEmail || '',
              authorDate: s.date || 0, committer: '', committerEmail: '', commitDate: s.date || 0,
              refs: [{ type: 'stash', name: 'stash@{' + s.index + '}' }],
              message: s.message,
              _isStash: true,
              _stashIndex: s.index,
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

function findCommit(hash) {
  return getDisplayCommits().find((c) => c.hash === hash) || null;
}

function stashByHash(hash) {
  return state.stashes.find((s) => s.hash === hash) || null;
}

function remotePrefixes() {
  return state.remotes.map((r) => r.name + '/');
}

function isRemoteBranchName(name) {
  return remotePrefixes().some((p) => String(name).startsWith(p));
}

// --- Ref pills ---
/*
 * The parser can only guess which refs are remote, and guesses wrong for a
 * local branch with a slash in its name; the remotes the repository actually
 * has decide instead. A local branch whose remote counterpart points at the
 * same commit shows one pill with a cloud rather than two.
 */
function classifyRefs(refs) {
  const prefixes = remotePrefixes();
  const classified = (refs || []).map((ref) => {
    if (ref.type === 'head' || ref.type === 'tag' || ref.type === 'stash') return ref;
    return { name: ref.name, type: prefixes.some((p) => ref.name.startsWith(p)) ? 'remote' : 'local' };
  });
  const localNames = new Set(classified.filter((r) => r.type === 'head' || r.type === 'local').map((r) => r.name));
  const merged = new Set();
  classified.forEach((ref) => {
    if (ref.type !== 'remote') return;
    const prefix = prefixes.find((p) => ref.name.startsWith(p));
    if (localNames.has(prefix ? ref.name.slice(prefix.length) : ref.name)) merged.add(ref.name);
  });
  const out = [];
  classified.forEach((ref) => {
    if (ref.type === 'tag' && !state.settings.showTags) return;
    if (ref.type === 'remote' && !state.settings.showRemoteBranches) return;
    if (merged.has(ref.name)) return;
    const synced = (ref.type === 'head' || ref.type === 'local')
      && classified.some((r) => r.type === 'remote' && prefixes.some((p) => r.name === p + ref.name));
    out.push({ name: ref.name, type: ref.type, synced });
  });
  // The checked-out branch first: on a phone only the first pill is shown.
  out.sort((a, b) => (b.type === 'head') - (a.type === 'head'));
  return out;
}

function headAhead() {
  const b = state.changes && state.changes.branch;
  return b && b.head === state.currentBranch ? (b.ahead || 0) : 0;
}

function refPillHtml(ref) {
  const name = escHtml(ref.name);
  const type = ref.type;
  const icon = type === 'remote' ? 'cloud' : type === 'tag' ? 'tag' : type === 'stash' ? 'stash' : 'branch';
  const ahead = type === 'head' ? headAhead() : 0;
  const what = type === 'head' ? ' · checked out' + (ahead ? ' · ' + plural(ahead, 'commit') + ' to push' : '')
    : type === 'remote' ? ' · remote branch' : type === 'tag' ? ' · tag' : type === 'stash' ? ' · stash'
    : ref.synced ? ' · in sync with its remote' : '';
  return '<span class="ref' + (type === 'head' ? ' head' : type === 'remote' ? ' remote' : '') + '" data-ref="' + name
    + '" data-ref-type="' + escHtml(type) + '" title="' + name + escHtml(what) + '">'
    + ic(icon) + '<span>' + name + '</span>'
    + (ref.synced ? ic('cloud', 'ic-xs cloud') : '')
    + (ahead ? '<span class="ahead">' + ic('arrow-up') + ahead + '</span>' : '')
    + '</span>';
}

function refPillsHtml(commit) {
  return classifyRefs(commit.refs).map(refPillHtml).join('');
}

// --- Rows ---
function wipTotals() {
  return changeTotals(changedFiles());
}

function segsHtml(totals, cap) {
  const max = cap || 30;
  const n = Math.min(totals.blocks, max);
  const lit = totals.blocks > max ? Math.round((totals.blocksStaged / totals.blocks) * max) : totals.blocksStaged;
  let html = '';
  for (let i = 0; i < n; i++) html += '<i' + (i < lit ? ' class="on"' : '') + '></i>';
  return '<span class="segs" aria-hidden="true">' + html + '</span>';
}

function wipCounts() {
  let added = 0, removed = 0;
  for (const f of changedFiles()) { const c = changeCounts(f); added += c.added; removed += c.removed; }
  return { added, removed };
}

function wipMessageHtml() {
  const t = wipTotals();
  const conflicts = t.conflicts ? ' · <span class="bad">' + escHtml(plural(t.conflicts, 'conflict')) + '</span>' : '';
  return '<span class="msg-subject">Uncommitted changes</span>'
    + '<span class="wip-meta">' + segsHtml(t) + '<span>' + t.blocksStaged + ' of ' + escHtml(plural(t.blocks, 'block')) + ' staged' + conflicts
    // The Author column says this on a wide row; a phone row has no columns.
    + '<span class="wip-files"> · ' + escHtml(plural(t.files, 'file')) + '</span></span></span>'
    + '<button type="button" class="quick" data-act="review" title="Review block by block">' + ic('file-diff', 'ic-sm') + 'Review</button>';
}

function wipAuthorHtml() {
  return '<span class="avatar wip-badge" aria-hidden="true">' + ic('edit', 'ic-xs') + '</span><span>' + escHtml(plural(changedFiles().length, 'file')) + '</span>';
}

function renderCommitList() {
  const container = document.getElementById('commit-list');
  container.innerHTML = '';

  const displayCommits = getDisplayCommits();
  graphLoadCommits(displayCommits);
  state.renderedAhead = headAhead();

  if (!displayCommits.length) {
    container.innerHTML = state.commitsLoaded ? '<div class="list-empty">No commits to show</div>' : '';
  }

  displayCommits.forEach((commit) => {
    const isWip = !!commit._isWip;
    const isStash = !!commit._isStash;
    const row = document.createElement('div');
    row.className = 'commit-row' + (isWip ? ' wip' : '') + (isStash ? ' stash' : '')
      + (!isWip && !isStash && commit.parents.length > 1 ? ' merge' : '');
    row.dataset.hash = commit.hash;
    row.setAttribute('role', 'row');

    // Graph spacer column (the SVG overlays this area).
    const graphCol = document.createElement('div');
    graphCol.className = 'col-graph';

    const msgCol = document.createElement('div');
    msgCol.className = 'col-message';
    const changesCol = document.createElement('div');
    changesCol.className = 'col-changes';
    const authorCol = document.createElement('div');
    authorCol.className = 'col-author';
    const dateCol = document.createElement('div');
    dateCol.className = 'col-date';
    const hashCol = document.createElement('div');
    hashCol.className = 'col-hash';

    if (isWip) {
      msgCol.innerHTML = wipMessageHtml();
      const c = wipCounts();
      changesCol.innerHTML = countsHtml(c.added, c.removed);
      authorCol.innerHTML = wipAuthorHtml();
      dateCol.textContent = 'now';
    } else if (isStash) {
      const pills = refPillsHtml(commit);
      msgCol.innerHTML = (pills ? '<span class="refs">' + pills + '</span>' : '')
        + '<span class="msg-subject" title="' + escHtml(commit.message) + '">' + escHtml(commit.message) + '</span>'
        + '<span class="msg-meta">' + escHtml(commit.author) + ' · ' + escHtml(formatDate(commit.commitDate)) + '</span>';
      changesCol.innerHTML = NOT_COUNTED;
      changesCol.title = 'Open the stash to see what it changed';
      authorCol.innerHTML = avatarFor(commit.author, commit.authorEmail) + '<span>' + escHtml(commit.author) + '</span>';
      authorCol.title = commit.author + (commit.authorEmail ? ' <' + commit.authorEmail + '>' : '');
      dateCol.textContent = formatDate(commit.commitDate);
      dateCol.title = absDate(commit.commitDate);
    } else {
      const subject = firstLine(commit.message);
      const pills = refPillsHtml(commit);
      // Branch names first, as the Git Graph had them before the redesign: they are what a reader
      // scans the list for, and placed after a long subject they were squeezed to a few characters.
      msgCol.innerHTML = (pills ? '<span class="refs">' + pills + '</span>' : '')
        + '<span class="msg-subject" title="' + escHtml(subject) + '">' + escHtml(subject) + '</span>'
        + '<span class="msg-meta">' + escHtml(commit.author) + ' · ' + escHtml(formatDate(commit.commitDate)) + ' · ' + escHtml(commit.hash.substring(0, 7)) + '</span>';
      if (commit.parents.length > 1) {
        changesCol.innerHTML = NOT_COUNTED;
        changesCol.title = 'git does not count what a merge changed';
      } else {
        fillChangesCell(changesCol, state.stats[commit.hash]);
      }
      authorCol.innerHTML = avatarFor(commit.author, commit.authorEmail) + '<span>' + escHtml(commit.author) + '</span>';
      authorCol.title = commit.author + (commit.authorEmail ? ' <' + commit.authorEmail + '>' : '');
      dateCol.textContent = formatDate(commit.commitDate);
      // The column is relative by default, so the exact moment goes in the
      // title rather than in a wider column.
      dateCol.title = absDate(commit.commitDate);
      hashCol.textContent = commit.hash.substring(0, 7);
    }

    row.appendChild(graphCol);
    row.appendChild(msgCol);
    row.appendChild(changesCol);
    row.appendChild(authorCol);
    row.appendChild(dateCol);
    row.appendChild(hashCol);

    wireRefPills(row, commit);
    makeRowDropTarget(row, commit);
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="review"]')) { e.stopPropagation(); openReview(); return; }
      selectCommit(commit.hash);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showRowMenu(commit, { x: e.clientX, y: e.clientY });
    });
    setupLongPress(row, (x, y) => showRowMenu(commit, { x, y }));
    container.appendChild(row);
  });

  wipRowSig = wipRowSignature();
  graphRender();
  applySelectionMarks();
  applySearchToRows();
  renderScrollMarkers();
  applyCommitStats();
}

/** What the uncommitted row shows, to tell a refresh that changed it from one that did not. */
function wipRowSignature() {
  if (!showWipRow()) return '';
  const t = wipTotals();
  const c = wipCounts();
  return [t.files, t.blocks, t.blocksStaged, t.conflicts, c.added, c.removed].join(',');
}

/** Refresh the uncommitted row in place: the five-second poll must not rebuild the list. */
function updateWipRow() {
  const sig = wipRowSignature();
  if (sig === wipRowSig) return;
  wipRowSig = sig;
  const row = document.querySelector('#commit-list .commit-row.wip');
  if (!row) return;
  row.querySelector('.col-message').innerHTML = wipMessageHtml();
  const c = wipCounts();
  row.querySelector('.col-changes').innerHTML = countsHtml(c.added, c.removed);
  row.querySelector('.col-author').innerHTML = wipAuthorHtml();
}

function wireRefPills(root, commit) {
  root.querySelectorAll('.ref[data-ref]').forEach((pill) => {
    const refName = pill.dataset.ref;
    const refType = pill.dataset.refType;
    makeRefDraggable(pill, refName, refType);
    if (refType !== 'stash') {
      pill.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        checkoutRef(refName, refType);
      });
    }
    pill.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (refType === 'stash') showRowMenu(commit, { x: e.clientX, y: e.clientY });
      else showRefMenu(refName, refType, commit, { x: e.clientX, y: e.clientY });
    });
  });
}

/*
 * A merge commit has no diffstat — that is git's default, not a failure — and a
 * stash is not in the log at all, so their rows say "not counted" with a dash
 * rather than claiming they changed nothing. Any other row stays empty until
 * its numbers arrive.
 */
const NOT_COUNTED = '<span class="muted">—</span>';

function fillChangesCell(cell, stat) {
  cell.textContent = '';
  cell.title = '';
  if (!stat) return;
  cell.innerHTML = countsHtml(stat.insertions, stat.deletions);
  cell.title = plural(stat.files, 'file') + ' changed';
}

/** Fill the column in place: the rows are already drawn, and rebuilding them
 *  would throw away the scroll position and the open inspector. */
function applyCommitStats() {
  document.querySelectorAll('#commit-list .commit-row').forEach((row) => {
    if (row.classList.contains('wip') || row.classList.contains('stash')) return;
    const cell = row.querySelector('.col-changes');
    const hash = row.dataset.hash;
    if (cell && hash && state.stats[hash]) fillChangesCell(cell, state.stats[hash]);
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

  const matches = new Set(state.searchMatches);
  for (let i = 0; i < commits.length; i++) if (matches.has(commits[i].hash)) mark(i, 'search');
  for (let i = 0; i < commits.length; i++) {
    if (commits[i].hash === state.head) mark(i, 'head');
    if (commits[i].hash === state.selectedCommit && state.inspectorOpen) mark(i, 'selected');
  }
}

// --- Selection ---
function rowFor(hash) {
  return hash ? document.querySelector('#commit-list .commit-row[data-hash="' + CSS.escape(hash) + '"]') : null;
}

function applySelectionMarks() {
  document.querySelectorAll('#commit-list .commit-row.selected').forEach((el) => {
    el.classList.remove('selected');
    el.removeAttribute('aria-selected');
  });
  const row = rowFor(state.selectedCommit);
  if (row) { row.classList.add('selected'); row.setAttribute('aria-selected', 'true'); }
}

/*
 * Pick a row: it is marked, and the inspector describes it — opened, unless
 * the caller only wants the mark (find stepping through matches on a phone,
 * where the inspector is a sheet over the list being searched).
 */
function selectCommit(hash, opts) {
  opts = opts || {};
  state.selectedCommit = hash;
  state.detail = null;
  if (!opts.keepClosed) state.inspectorOpen = true;
  applySelectionMarks();
  applyInspectorVisibility();
  renderScrollMarkers();
  renderInspector(opts.fallback);
  if (opts.scroll) {
    const row = rowFor(hash);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

/* One dismiss for the close button, the scrim and Escape. The row keeps its
   mark on a wide panel — the inspector can be reopened onto it — and loses it
   on a phone, where the sheet was the only thing the mark explained. */
function closeDetailPanel() {
  state.inspectorOpen = false;
  applyInspectorVisibility();
  renderScrollMarkers();
}

function applyInspectorVisibility() {
  const open = state.inspectorOpen;
  document.documentElement.classList.toggle('insp-closed', !open);
  document.getElementById('sheet-scrim').classList.toggle('hidden', !open || !isNarrowLayout());
  const btn = document.getElementById('btn-inspector');
  if (btn) {
    btn.setAttribute('aria-pressed', String(open));
    btn.title = open ? 'Hide details' : 'Show details';
  }
}

/** Move the selection one row up or down — the keyboard's way through the list. */
function stepSelection(dir) {
  const rows = Array.from(document.querySelectorAll('#commit-list .commit-row'));
  if (!rows.length) return;
  const at = rows.findIndex((r) => r.dataset.hash === state.selectedCommit);
  const next = rows[Math.max(0, Math.min(rows.length - 1, at === -1 ? 0 : at + dir))];
  if (!next || next.dataset.hash === state.selectedCommit) return;
  selectCommit(next.dataset.hash, { keepClosed: !state.inspectorOpen });
  next.scrollIntoView({ block: 'nearest' });
}

/*
 * The first time both the history and the working tree have arrived, a wide
 * panel opens on something: the uncommitted changes if there are any, else the
 * checked-out commit. Once only — after that the selection is the reader's.
 */
function maybeAutoSelect() {
  if (state.autoSelected || !state.commitsLoaded || !state.changesLoaded) return;
  state.autoSelected = true;
  if (!isColumnLayout() || state.selectedCommit) return;
  if (showWipRow()) selectCommit('uncommitted');
  else if (state.head && rowFor(state.head)) selectCommit(state.head);
}

// --- Find ---
/*
 * "Loaded commits" marks matches among the rows already drawn and dims the
 * rest; the other modes ask git about the whole history, because a commit
 * older than the current page is otherwise invisible to a search.
 */
const FIND_MODES = [
  { id: 'loaded', label: 'Loaded commits', chip: 'Loaded', placeholder: 'Find commits' },
  { id: 'message', label: 'Message', chip: 'Message', placeholder: 'Search all history by message' },
  { id: 'author', label: 'Author', chip: 'Author', placeholder: 'Search all history by author' },
  { id: 'content', label: 'Code change', chip: 'Code', placeholder: 'Search code added or removed' },
  { id: 'file', label: 'File path', chip: 'Path', placeholder: 'Commits touching a path' },
];
let findMode = 'loaded';

function findInputEl() { return document.getElementById('find-input'); }

/* The short form is what a phone shows: there the box shares the toolbar with four 44px
   buttons and the mode chip. The long form stays in the page for screen readers. */
function setFindCount(text, short) {
  document.getElementById('find-count').innerHTML = text
    ? '<span class="long">' + escHtml(text) + '</span><span class="short" aria-hidden="true">' + escHtml(short || text) + '</span>'
    : '';
}

function setFindMode(id) {
  const mode = FIND_MODES.find((m) => m.id === id) || FIND_MODES[0];
  findMode = mode.id;
  const chip = document.getElementById('find-mode');
  chip.innerHTML = escHtml(mode.chip) + ic('chev-d', 'ic-xs');
  chip.title = 'Search in: ' + mode.label;
  findInputEl().placeholder = mode.placeholder;
  hideSearchResults();
  if (findMode === 'loaded') doSearch(findInputEl().value);
  else { clearSearchMarks(); if (findInputEl().value.trim()) runHistorySearch(); }
}

function doSearch(query) {
  const q = String(query || '').trim().toLowerCase();
  state.searchQuery = q;
  state.searchMatches = [];
  state.searchIndex = -1;
  if (q) {
    // By hash, not by row: the list is drawn again under a kept search — the uncommitted
    // row comes and goes, a history is read again — and the rows move.
    getDisplayCommits().forEach((commit) => {
      if (commit._isWip) return;
      if (String(commit.message).toLowerCase().includes(q)
        || String(commit.author).toLowerCase().includes(q)
        || commit.hash.toLowerCase().startsWith(q)) state.searchMatches.push(commit.hash);
    });
  }
  applySearchToRows();
  const found = state.searchMatches.length;
  setFindCount(q ? (found ? found + ' found' : 'none') : '', found ? String(found) : 'none');
  renderScrollMarkers();
}

/** Marks and dims the drawn rows for the current query. */
function applySearchToRows() {
  const q = findMode === 'loaded' ? state.searchQuery : '';
  const matches = new Set(state.searchMatches);
  // Rows are drawn one per display commit, in order, so a row's index is its commit's.
  const commits = getDisplayCommits();
  const current = state.searchIndex >= 0 ? state.searchMatches[state.searchIndex] : null;
  document.querySelectorAll('#commit-list .commit-row').forEach((row, idx) => {
    const isWip = row.classList.contains('wip');
    const hit = !!q && matches.has(row.dataset.hash);
    row.classList.toggle('search-match', hit);
    row.classList.toggle('find-current', hit && row.dataset.hash === current);
    row.classList.toggle('dim', !!q && !hit);
    if (isWip || row.classList.contains('stash')) return;
    const commit = commits[idx];
    if (!commit || commit.hash !== row.dataset.hash) return;
    const subject = row.querySelector('.msg-subject');
    if (subject) subject.innerHTML = markText(firstLine(commit.message), hit ? q : '');
    const author = row.querySelector('.col-author > span:last-child');
    if (author) author.innerHTML = markText(commit.author, hit ? q : '');
    const hash = row.querySelector('.col-hash');
    if (hash) {
      const short = commit.hash.substring(0, 7);
      hash.innerHTML = hit && short.startsWith(q) ? '<mark>' + escHtml(short.slice(0, q.length)) + '</mark>' + escHtml(short.slice(q.length)) : escHtml(short);
    }
  });
}

function clearSearchMarks() {
  state.searchQuery = '';
  state.searchMatches = [];
  state.searchIndex = -1;
  applySearchToRows();
  setFindCount('');
  renderScrollMarkers();
}

function navigateSearch(dir) {
  if (state.searchMatches.length === 0) return;
  const n = state.searchMatches.length;
  state.searchIndex = state.searchIndex === -1 ? (dir < 0 ? n - 1 : 0) : (state.searchIndex + dir + n) % n;
  const hash = state.searchMatches[state.searchIndex];
  document.querySelectorAll('#commit-list .commit-row').forEach((r) => r.classList.toggle('find-current', r.dataset.hash === hash));
  const row = rowFor(hash);
  if (row) {
    selectCommit(row.dataset.hash, { keepClosed: !isColumnLayout() && !state.inspectorOpen });
    row.scrollIntoView({ block: 'center' });
  }
  setFindCount((state.searchIndex + 1) + ' of ' + n, (state.searchIndex + 1) + '/' + n);
}

function runHistorySearch() {
  const text = findInputEl().value.trim();
  if (!text) { hideSearchResults(); setFindCount(''); return; }
  setFindCount('searching…', '…');
  vscode.postMessage({ command: 'searchCommits', mode: findMode, text });
}

function hideSearchResults() {
  const el = document.getElementById('search-results');
  el.classList.add('hidden');
  el.innerHTML = '';
}

function renderSearchResults(data) {
  const el = document.getElementById('search-results');
  const hits = (data && data.hits) || [];
  setFindCount(hits.length + ' found', String(hits.length));
  const loaded = new Set(getDisplayCommits().map((c) => c.hash));
  let html = '<div class="sr-head">' + (hits.length
    ? escHtml(plural(hits.length, 'commit')) + ' across all history'
    : 'Nothing in this repository matches') + '<span class="grow"></span><button type="button" class="tool" data-act="sr-close" aria-label="Close results">' + ic('x', 'ic-sm') + '</button></div>';
  html += hits.map((h) => '<button type="button" class="sr-item" data-hash="' + escHtml(h.hash) + '">'
    + '<span class="sr-subject">' + escHtml(h.subject) + '</span>'
    + '<span class="sr-meta">' + avatarFor(h.author, h.authorEmail)
      + '<span>' + escHtml(h.author) + '</span>'
      + '<span>' + escHtml(formatDate(h.authorDate)) + '</span>'
      + '<span class="sr-hash">' + escHtml(h.hash.substring(0, 7)) + '</span>'
      + (loaded.has(h.hash) ? '' : '<span>not in the loaded range</span>')
    + '</span></button>').join('');
  el.innerHTML = html;
  el.classList.remove('hidden');
  el._hits = hits;
}

{
  const results = document.getElementById('search-results');
  results.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="sr-close"]')) { hideSearchResults(); return; }
    const item = e.target.closest('.sr-item');
    if (!item) return;
    const hash = item.dataset.hash;
    const hit = (results._hits || []).find((h) => h.hash === hash);
    hideSearchResults();
    // Scroll to the row when this commit is loaded; otherwise open its details
    // from what the search knows, since loading the intervening history could
    // be thousands of rows.
    const row = rowFor(hash);
    if (row) { selectCommit(hash); row.scrollIntoView({ block: 'center' }); return; }
    selectCommit(hash, { fallback: hit ? {
      hash, parents: [], author: hit.author, authorEmail: hit.authorEmail, authorDate: hit.authorDate,
      committer: hit.author, committerEmail: hit.authorEmail, commitDate: hit.authorDate, message: hit.subject, refs: [],
    } : null });
  });

  const input = findInputEl();
  input.addEventListener('input', () => {
    if (findMode === 'loaded') doSearch(input.value);
    else if (!input.value.trim()) { hideSearchResults(); setFindCount(''); }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (findMode === 'loaded') navigateSearch(e.shiftKey ? -1 : 1);
      else runHistorySearch();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (input.value) clearFind();
      else closeFind();
    }
  });
  document.getElementById('find-next').addEventListener('click', () => navigateSearch(1));
  document.getElementById('find-prev').addEventListener('click', () => navigateSearch(-1));
  document.getElementById('find-close').addEventListener('click', () => {
    if (input.value) { clearFind(); input.focus(); }
    else closeFind();
  });
  document.getElementById('find-mode').addEventListener('click', (e) => {
    e.preventDefault();
    openMenu(FIND_MODES.map((m) => ({
      label: m.label,
      checked: m.id === findMode,
      action: () => { setFindMode(m.id); input.focus(); },
    })), e.currentTarget);
  });
}

function clearFind() {
  findInputEl().value = '';
  hideSearchResults();
  clearSearchMarks();
}

/** A phone has no room for the field beside the toolbar, so find takes the bar over. */
function openFind() {
  if (isNarrowLayout()) document.getElementById('toolbar').classList.add('find-open');
  const input = findInputEl();
  input.focus();
  input.select();
}

function closeFind() {
  clearFind();
  document.getElementById('toolbar').classList.remove('find-open');
  findInputEl().blur();
}
`;
}
