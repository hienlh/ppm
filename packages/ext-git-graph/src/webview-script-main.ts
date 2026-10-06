/**
 * The Git Graph script's last part: what the host sends and what the panel
 * does with it, the keyboard, paging, and the first paint. It runs last
 * because it is the only part that starts anything — every other part only
 * declares functions and wires listeners.
 *
 * Part of one shared script; see webview-script-core.ts for the rules.
 */
export function mainScript(): string {
  return String.raw`
// --- What the host sends ---
/*
 * The working tree is read every five seconds. Most reads change nothing; one
 * that does is either a new HEAD — a commit made anywhere, here, in Source
 * Control or in a terminal — or a different set of changed files.
 */
function onChangesUpdated() {
  const c = state.changes;
  const hadRow = !!document.querySelector('#commit-list .commit-row.wip');
  const oid = c && c.branch ? c.branch.oid : null;
  if (oid && state.commitsLoaded) {
    // HEAD and the branch name together: switching to a branch on the same
    // commit moves no hash, and still moves the checked-out pill.
    const key = oid + '|' + (c.branch.head || 'HEAD');
    if (key !== state.head + '|' + (state.currentBranch || 'HEAD') && key !== state.requestedOid) {
      state.requestedOid = key;
      vscode.postMessage({ command: 'requestRepoInfo' });
      vscode.postMessage({ command: 'requestCommits', branch: state.scope === 'all' ? undefined : state.scope, maxCommits: refreshCount() });
    }
  }
  if (state.commitsLoaded && (showWipRow() !== hadRow || headAhead() !== state.renderedAhead)) renderCommitList();
  else updateWipRow();
  renderOpBanner();
  renderSync();
  if (state.selectedCommit === 'uncommitted') {
    if (changedFiles().length) updateWipPanel();
    // Everything was committed or put away: what is left to describe is the
    // commit the changes went into.
    else if (state.head && rowFor(state.head)) selectCommit(state.head, { keepClosed: !state.inspectorOpen });
    else renderInspector();
  }
  state.changesLoaded = true;
  maybeAutoSelect();
}

/* A stash popped or dropped takes its row with it, and the inspector with it
   if that was the row it described. */
function onStashesChanged() {
  if (state.commitsLoaded) renderCommitList();
  renderToolbar();
  const panel = document.getElementById('detail-panel');
  const sel = state.selectedCommit;
  if (sel && panel.dataset.view === 'stash' && !stashByHash(sel)) {
    state.selectedCommit = null;
    state.detail = null;
    applySelectionMarks();
    renderInspector();
    if (isNarrowLayout()) closeDetailPanel();
  }
}

function applyIncomingDraft(draft) {
  if (!draft) return;
  state.draft = draft;
  applyDraft();
  updateCommitControls();
}

/* A re-read asks for as many commits as the list holds: the first page alone
   would take the ones scrolled into view from under the reader. */
function refreshCount() {
  return Math.max(state.maxCommits, state.commits.length);
}

function loadMoreCommits() {
  if (state.loading || !state.hasMore) return;
  state.loading = true;
  document.getElementById('loading').classList.remove('hidden');
  vscode.postMessage({
    command: 'requestCommits', branch: state.scope === 'all' ? undefined : state.scope,
    maxCommits: state.maxCommits, skip: state.commits.length,
  });
}

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.command) {
    case 'loadRepoInfo': {
      const d = msg.data || {};
      state.repo = d.path || '';
      state.branches = d.branches || [];
      state.tags = d.tags || [];
      state.remotes = d.remotes || [];
      state.head = d.head || '';
      state.currentBranch = d.currentBranch || '';
      state.remoteWeb = d.remoteWeb || null;
      const stashes = d.stashes || [];
      const stashesChanged = JSON.stringify(stashes) !== JSON.stringify(state.stashes);
      state.stashes = stashes;
      renderToolbar();
      updateStatus();
      if (settingsOpen()) renderRemotesList();
      if (stashesChanged) onStashesChanged();
      break;
    }
    case 'loadCommits': {
      const page = msg.data || [];
      if (msg.append) {
        // A page asked for before the list was replaced continues a list that is
        // gone: appended, it would leave a gap in the history or repeat a stretch.
        if (msg.skip !== state.commits.length) break;
        state.commits = state.commits.concat(page);
      } else {
        state.commits = page;
        // A replaced list starts its stats over: nothing would ever read the
        // old numbers again, and nothing would ever drop them either.
        state.stats = {};
        if (msg.scope) state.scope = msg.scope;
      }
      state.hasMore = page.length >= state.maxCommits;
      state.commitsLoaded = true;
      state.loading = false;
      document.getElementById('loading').classList.add('hidden');
      renderToolbar();
      renderCommitList();
      updateStatus();
      maybeAutoSelect();
      break;
    }
    case 'loadCommitStats':
      Object.assign(state.stats, msg.data || {});
      applyCommitStats();
      break;
    case 'commitDetails':
      receiveDetail(msg.data);
      break;
    case 'loadSearchResults':
      renderSearchResults(msg.data);
      break;
    case 'loadChanges':
      state.changes = msg.data || null;
      state.changesError = msg.error || null;
      onChangesUpdated();
      break;
    // From the app rather than the host: the file icons the inspector asked for.
    case '__ppm.fileIcons':
      receiveFileIcons(msg);
      break;
    case 'loadDraft':
      applyIncomingDraft(msg.data);
      break;
    case 'loadStashes': {
      const stashes = msg.data || [];
      const changed = JSON.stringify(stashes) !== JSON.stringify(state.stashes);
      state.stashes = stashes;
      if (changed) onStashesChanged();
      break;
    }
    case 'loadWorktrees':
      state.worktrees = msg.data || [];
      renderToolbar();
      break;
    case 'loadSubmodules':
      state.submodules = msg.data || [];
      renderToolbar();
      break;
    case 'loadSettings':
      state.settings = { ...DEFAULT_SETTINGS, ...(msg.data || {}) };
      state.maxCommits = state.settings.maxCommits;
      applySettingsToUI();
      if (state.commitsLoaded) renderCommitList();
      break;
    case 'loadUserDetails':
      state.userDetails = msg.data || { name: '', email: '' };
      document.getElementById('s-userName').value = state.userDetails.name || '';
      document.getElementById('s-userEmail').value = state.userDetails.email || '';
      break;
    case 'loadOwnerRepo':
      if (msg.data && msg.data.owner) document.getElementById('pr-owner').value = msg.data.owner;
      if (msg.data && msg.data.repo) document.getElementById('pr-repo').value = msg.data.repo;
      break;
    case 'actionResult': {
      // null: asked for and deliberately unanswered (the silent fetch).
      // undefined: nobody asked here, so a failure is still worth saying.
      const cb = takePending(msg.action, msg.reqId);
      const result = msg.result || { ok: false, error: 'The host gave no answer.' };
      if (cb) cb(result, msg);
      else if (cb === undefined && !result.ok) showActionError('Git action failed', result.error);
      break;
    }
    case 'error': {
      // A request the host could not even start still owes its asker an answer,
      // or its button would wait forever.
      if (msg.failed) {
        const cb = takePending(msg.failed, msg.reqId);
        if (cb) { cb({ ok: false, error: msg.message }, msg); break; }
        if (cb === null) break;
      }
      if (/searching/.test(document.getElementById('find-count').textContent)) setFindCount('');
      state.loading = false;
      document.getElementById('loading').classList.add('hidden');
      showToast('Something went wrong', { kind: 'error', description: msg.message });
      break;
    }
  }
});

// --- Keyboard ---
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (document.querySelector('.dialog-overlay')) return;
  if (mod && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openFind(); return; }
  if (e.key === 'Escape') {
    if (menuIsOpen()) { closeMenu(); return; }
    if (settingsOpen()) { closeSettings(); return; }
    if (!document.getElementById('search-results').classList.contains('hidden')) { hideSearchResults(); return; }
    if (document.getElementById('toolbar').classList.contains('find-open') || findInputEl().value) { closeFind(); return; }
    if (state.inspectorOpen) closeDetailPanel();
    return;
  }
  const t = e.target;
  if (menuIsOpen() || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    stepSelection(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter' && state.selectedCommit && !state.inspectorOpen && t === document.body) {
    selectCommit(state.selectedCommit);
    return;
  }
  // Copy what is selected, when no text is: the hash, or a stash's name.
  if (mod && (e.key === 'c' || e.key === 'C')) {
    const text = window.getSelection ? String(window.getSelection()) : '';
    const hash = state.selectedCommit;
    if (text || !hash || hash === 'uncommitted') return;
    e.preventDefault();
    const stash = stashByHash(hash);
    if (stash) copyWithToast('stash@{' + stash.index + '}', 'the stash name');
    else copyWithToast(hash, 'the hash');
  }
});

// --- Paging, links, layout ---
{
  document.getElementById('graph-container').addEventListener('scroll', (e) => {
    const c = e.currentTarget;
    if (c.scrollTop + c.clientHeight >= c.scrollHeight - 200) loadMoreCommits();
  }, { passive: true });
  document.getElementById('btn-load-more').addEventListener('click', loadMoreCommits);

  // A link in a commit message: the frame is sandboxed without popups, so the
  // app opens it.
  document.addEventListener('click', (e) => {
    const a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    openExternal(a.getAttribute('href'));
  });

  let wasNarrow = isNarrowLayout();
  window.addEventListener('resize', () => {
    const narrow = isNarrowLayout();
    if (narrow === wasNarrow) return;
    wasNarrow = narrow;
    applyInspectorVisibility();
    if (!narrow) document.getElementById('toolbar').classList.remove('find-open');
  });
}

// --- First paint ---
setFindMode('loaded');
renderToolbar();
updateStatus();
applyInspectorVisibility();
renderInspector();
vscode.postMessage({ command: 'ready' });
`;
}
