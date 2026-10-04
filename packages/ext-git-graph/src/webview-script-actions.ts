/**
 * The Git Graph script's actions: the toolbar's menus and sync buttons, every
 * context menu, the git commands behind them, the working-tree writes the
 * inspector's composer makes, and the banner for a stopped merge or rebase.
 *
 * The working-tree half says what it did in the same words Source Control
 * uses (git-status-panel.tsx), because it is the same action reached from
 * another place.
 *
 * Part of one shared script; see webview-script-core.ts for the rules.
 */
export function actionsScript(): string {
  return String.raw`
// --- Busy, and the sync buttons ---
function branchState() {
  return (state.changes && state.changes.branch) || null;
}

/** The branch the toolbar is about, for sentences: a detached HEAD has none. */
function currentName() {
  return state.currentBranch && state.currentBranch !== 'HEAD' ? state.currentBranch : 'HEAD';
}

function renderBusy() {
  renderSync();
  updateCommitControls();
  renderOpBanner();
}

/** A count of writes in flight under one name, for the ones a second click may queue behind. */
function busyCount(name, delta) {
  const n = (Number(state.busy[name]) || 0) + delta;
  if (n > 0) state.busy[name] = n;
  else delete state.busy[name];
  renderBusy();
}

function syncTitle(mode, b) {
  const up = (b && b.upstream) || 'the remote';
  switch (mode) {
    case 'publish': return b && b.upstreamGone ? up + ' is gone from the remote: push the branch again' : 'Push this branch to the remote and track it';
    case 'sync': return 'Pull ' + b.behind + ' and push ' + b.ahead + ' with ' + up;
    case 'pull': return 'Pull ' + b.behind + ' from ' + up;
    case 'push': return 'Push to ' + up;
    case 'synced': return 'In sync with ' + up + ' · click to fetch';
  }
  return '';
}

/*
 * Fetch, Pull and Push side by side on a wide panel, so what each would do is
 * readable before it is done; on a phone one button, the same one Source
 * Control shows — Push ↑n, Pull ↓n, Sync, Publish, or Synced, which fetches.
 * It leads once nothing is left to commit.
 */
function renderSync() {
  const b = branchState();
  const mode = b ? syncMode(b) : null;
  const remotes = state.remotes.length > 0;
  const busy = anyBusy();
  const behind = (b && b.behind) || 0;
  const ahead = (b && b.ahead) || 0;
  const up = (b && b.upstream) || 'the remote';

  const fetchBtn = document.getElementById('btn-fetch');
  const fetching = !!state.busy.fetch;
  fetchBtn.disabled = busy || !remotes;
  fetchBtn.setAttribute('aria-busy', String(fetching));
  fetchBtn.innerHTML = ic(fetching ? 'spinner' : 'sync', 'ic-sm') + '<span class="lbl">Fetch</span>';
  fetchBtn.title = remotes ? 'Fetch from every remote' : 'This repository has no remote';

  const pullBtn = document.getElementById('btn-pull');
  const pulling = !!state.busy.pull;
  const canPull = !!(b && b.upstream && !b.upstreamGone && behind > 0);
  pullBtn.disabled = busy || !canPull;
  pullBtn.setAttribute('aria-busy', String(pulling));
  pullBtn.innerHTML = ic(pulling ? 'spinner' : 'pull', 'ic-sm') + '<span class="lbl">Pull</span><span class="num">' + (behind || '') + '</span>';
  pullBtn.title = canPull ? 'Pull ' + plural(behind, 'commit') + ' from ' + up
    : b && b.upstream && !b.upstreamGone ? 'Nothing to pull from ' + up : 'This branch has no upstream to pull from';

  const pushBtn = document.getElementById('btn-push');
  const publish = mode === 'publish';
  const pushing = !!(state.busy.push || state.busy.sync || state.busy.publish);
  pushBtn.disabled = busy || !(mode === 'push' || mode === 'sync' || publish);
  pushBtn.setAttribute('aria-busy', String(pushing));
  pushBtn.innerHTML = ic(pushing ? 'spinner' : publish ? 'cloud' : 'push', 'ic-sm') + '<span class="lbl">' + (publish ? 'Publish' : 'Push') + '</span>'
    + '<span class="num hot">' + (ahead && !publish ? ahead : '') + '</span>';
  pushBtn.title = mode === 'push' || mode === 'sync' || publish ? syncTitle(mode, b) : 'Nothing to push';

  const m = document.getElementById('btn-sync-m');
  m.classList.toggle('hidden', !mode);
  if (!mode) return;
  const icons = { publish: 'cloud', sync: 'sync', pull: 'pull', push: 'push', synced: 'check' };
  const labels = { publish: 'Publish', sync: 'Sync', pull: 'Pull', push: 'Push', synced: 'Synced' };
  const running = state.busy[mode] || (mode === 'synced' && state.busy.fetch);
  let counts = '';
  if (mode === 'sync' || mode === 'pull' || mode === 'push') {
    counts = '<span class="ab">'
      + (behind ? '<span>' + ic('arrow-down', 'ic-xs') + behind + '</span>' : '')
      + (ahead ? '<span class="up">' + ic('arrow-up', 'ic-xs') + ahead + '</span>' : '')
      + '</span>';
  }
  m.classList.toggle('primary', changedFiles().length === 0 && mode !== 'synced');
  m.disabled = busy;
  m.setAttribute('aria-busy', String(!!running));
  m.innerHTML = ic(running ? 'spinner' : icons[mode], 'ic-sm') + '<span class="lbl">' + labels[mode] + '</span>' + counts;
  m.title = syncTitle(mode, b);
}

function runSync(action) {
  if (anyBusy()) return;
  const b = branchState();
  const up = (b && b.upstream) || 'the remote';
  const ahead = (b && b.ahead) || 0;
  const behind = (b && b.behind) || 0;
  setBusy(action, true);
  request({ command: 'sync', action }, action, (result) => {
    setBusy(action, false);
    if (!result.ok) {
      const failed = { push: 'Push failed', pull: 'Pull failed', sync: 'Sync failed', publish: 'Publish failed', fetch: 'Fetch failed' };
      showActionError(failed[action] || 'Failed', result.error);
      return;
    }
    const data = result.data || {};
    if (action === 'push') showToast(ahead ? 'Pushed ' + plural(ahead, 'commit') + ' to ' + up : 'Pushed to ' + up, { kind: 'success' });
    else if (action === 'pull') showToast(behind ? 'Pulled ' + plural(behind, 'commit') + ' from ' + up : 'Pulled from ' + up, { kind: 'success' });
    else if (action === 'sync') showToast('In sync with ' + up, { kind: 'success' });
    else if (action === 'publish') showToast('Published ' + (data.branch || (b && b.head) || 'the branch') + ' to ' + (data.remote || 'the remote'), { kind: 'success' });
    else if (action === 'fetch') {
      const n = Number(data.behind) || 0;
      showToast(n ? 'Fetched — ' + plural(n, 'new commit') + ' to pull' : 'Fetched — nothing new');
    }
  });
}

/* The setting's own fetch says nothing and blocks nothing: it runs whether or
   not anyone is looking, and a commit must not wait for it. */
function startAutoFetch(sec) {
  if (autoFetchTimer) { clearInterval(autoFetchTimer); autoFetchTimer = null; }
  const n = Number(sec) || 0;
  if (n <= 0) return;
  autoFetchTimer = setInterval(() => {
    if (anyBusy() || !state.remotes.length) return;
    request({ command: 'sync', action: 'fetch' }, 'fetch', null);
  }, Math.max(n, 10) * 1000);
}

/*
 * A failure says which command failed and git's own words under it. A merge,
 * pull, rebase or cherry-pick that stops on a conflict is not a failure the
 * reader can do nothing about, though: the banner above the list is where it
 * goes on from, so that is what the toast points at.
 */
function showActionError(title, error) {
  const text = String(error || '').trim();
  if (/\bCONFLICT\b|fix conflicts|could not apply/i.test(text)) {
    showToast('Stopped on a conflict', { kind: 'warning', description: 'Resolve the conflicted files, then continue or abort from the banner above the list.' });
    return;
  }
  showToast(title, { kind: 'error', description: text || 'git did not say why.' });
}

/** One git command, its busy mark, and the sentence for either outcome. */
function runGitWrite(action, args, success, failure, then) {
  if (anyBusy()) return;
  setBusy(action, true);
  gitAction(action, args, (result) => {
    setBusy(action, false);
    if (!result.ok) { showActionError(failure, result.error); return; }
    if (success) showToast(success, { kind: 'success' });
    if (then) then(result);
  });
}

function reloadEverything() {
  vscode.postMessage({ command: 'requestRepoInfo' });
  vscode.postMessage({ command: 'requestCommits', branch: state.scope === 'all' ? undefined : state.scope, maxCommits: refreshCount() });
  vscode.postMessage({ command: 'requestChanges' });
  vscode.postMessage({ command: 'requestWorktrees' });
  vscode.postMessage({ command: 'requestStashes' });
  vscode.postMessage({ command: 'requestSubmodules' });
}

// --- The toolbar ---
function setToolCount(id, n) {
  const el = document.querySelector('#' + id + ' .n');
  if (el) el.textContent = n ? String(n) : '';
}

function renderToolbar() {
  const label = state.scope === 'all' ? 'All branches' : state.scope;
  document.getElementById('scope-label').textContent = label;
  document.getElementById('branch-selector').title = 'Showing ' + label + ' · click to change';
  setToolCount('btn-stash', state.stashes.length);
  // One worktree is the repository itself: only a second one is news.
  setToolCount('btn-worktree', state.worktrees.length > 1 ? state.worktrees.length : 0);
  setToolCount('btn-submodule', state.submodules.length);
  document.getElementById('btn-submodule').classList.toggle('hidden', !state.submodules.length);
  renderSync();
}

function localBranchNames() {
  return state.branches
    .filter((b) => !isRemoteBranchName(b.name) && !state.remotes.some((r) => r.name === b.name))
    .map((b) => b.name);
}

function scopeMenuItems() {
  const items = [{ heading: 'Branches' }, { label: 'All branches', checked: state.scope === 'all', action: () => setScope('all') }];
  const locals = localBranchNames();
  locals.sort((a, b) => (b === state.currentBranch) - (a === state.currentBranch));
  locals.forEach((name) => items.push({
    label: name, sub: name === state.currentBranch ? 'checked out' : '',
    checked: state.scope === name, action: () => setScope(name),
  }));
  if (state.settings.showRemoteBranches) {
    const remotes = state.branches.filter((b) => isRemoteBranchName(b.name) && !/\/HEAD$/.test(b.name));
    if (remotes.length) {
      items.push({ heading: 'Remote branches' });
      remotes.forEach((b) => items.push({ label: b.name, checked: state.scope === b.name, action: () => setScope(b.name) }));
    }
  }
  items.push({ separator: true }, { heading: 'Show' });
  items.push({ label: 'Remote branches', checked: !!state.settings.showRemoteBranches, action: () => toggleShowSetting('showRemoteBranches') });
  items.push({ label: 'Tags', checked: !!state.settings.showTags, action: () => toggleShowSetting('showTags') });
  items.push({ label: 'Stashes', checked: !!state.settings.showStashes, action: () => toggleShowSetting('showStashes') });
  return items;
}

function toggleShowSetting(key) {
  const value = !state.settings[key];
  state.settings[key] = value;
  vscode.postMessage({ command: 'updateSetting', key, value });
  const box = document.getElementById('s-' + key);
  if (box) box.checked = value;
  renderCommitList();
}

/** Show one branch's history, or everything. The host remembers it for the panel. */
function setScope(name) {
  if (name === state.scope) return;
  state.scope = name;
  state.commits = [];
  state.stats = {};
  state.commitsLoaded = false;
  state.hasMore = false;
  state.loading = true;
  renderToolbar();
  renderCommitList();
  updateStatus();
  document.getElementById('loading').classList.remove('hidden');
  vscode.postMessage({ command: 'requestCommits', branch: name === 'all' ? undefined : name, maxCommits: state.maxCommits });
}

function viewMenuItems() {
  const items = [];
  if (!isNarrowLayout()) {
    items.push({ heading: 'Columns' });
    columnMenuItems().forEach((it) => items.push(it));
    items.push({ separator: true });
  }
  // Below 700px the toolbar drops these three buttons; their menus live here.
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 700px)').matches) {
    items.push({ label: 'Stashes', icon: 'stash', children: stashListItems() });
    items.push({ label: 'Worktrees', icon: 'folder', children: worktreeMenuItems() });
    if (state.submodules.length) items.push({ label: 'Submodules', icon: 'cube', children: submoduleMenuItems() });
    items.push({ separator: true });
  }
  items.push({ label: 'Refresh', icon: 'sync', action: reloadEverything });
  items.push({ label: 'Reflog', icon: 'history', title: 'Undo a reset, a rebase or a deleted branch', action: () => vscode.postMessage({ command: 'openReflog' }) });
  items.push({ separator: true });
  items.push({ label: 'Git Graph settings…', icon: 'settings', action: openSettings });
  return items;
}

/* Opening with nothing selected would show an empty column, so it opens on
   what a wide panel opens on by itself: the changes, else the checked-out commit. */
function toggleInspector() {
  if (state.inspectorOpen) { closeDetailPanel(); return; }
  if (!state.selectedCommit) {
    if (showWipRow()) { selectCommit('uncommitted'); return; }
    if (state.head && rowFor(state.head)) { selectCommit(state.head, { scroll: true }); return; }
  }
  state.inspectorOpen = true;
  applyInspectorVisibility();
  renderScrollMarkers();
  if (document.getElementById('detail-panel').dataset.hash !== state.selectedCommit) renderInspector();
}

{
  document.getElementById('branch-selector').addEventListener('click', (e) => {
    openMenu(scopeMenuItems(), e.currentTarget, { filter: 'Filter branches' });
  });
  document.getElementById('btn-stash').addEventListener('click', (e) => openMenu(stashListItems(), e.currentTarget));
  document.getElementById('btn-worktree').addEventListener('click', (e) => {
    vscode.postMessage({ command: 'requestWorktrees' });
    openMenu(worktreeMenuItems(), e.currentTarget);
  });
  document.getElementById('btn-submodule').addEventListener('click', (e) => openMenu(submoduleMenuItems(), e.currentTarget));
  document.getElementById('btn-view').addEventListener('click', (e) => openMenu(viewMenuItems(), e.currentTarget));
  document.getElementById('btn-find').addEventListener('click', () => openFind());
  document.getElementById('btn-inspector').addEventListener('click', toggleInspector);
  document.getElementById('btn-fetch').addEventListener('click', () => runSync('fetch'));
  document.getElementById('btn-pull').addEventListener('click', () => runSync('pull'));
  document.getElementById('btn-push').addEventListener('click', () => {
    const b = branchState();
    const mode = b ? syncMode(b) : null;
    runSync(mode === 'sync' ? 'sync' : mode === 'publish' ? 'publish' : 'push');
  });
  document.getElementById('btn-sync-m').addEventListener('click', () => {
    const b = branchState();
    const mode = b ? syncMode(b) : null;
    if (mode) runSync(mode === 'synced' ? 'fetch' : mode);
  });
}

// --- Stashes ---
function stashListItems() {
  const items = [{ heading: 'Stashes' }];
  if (!state.stashes.length) items.push({ empty: 'No stashes' });
  state.stashes.forEach((s) => {
    const parts = stashParts(s.message);
    const children = [];
    if (rowFor(s.hash)) children.push({ label: 'Show in graph', icon: 'eye', action: () => selectCommit(s.hash, { scroll: true }) });
    items.push({
      label: parts.message || '(no message)', icon: 'stash',
      row2: 'stash@{' + s.index + '}' + (parts.branch ? ' · on ' + parts.branch : ''),
      children: children.concat(stashMenuItems(s.hash)),
    });
  });
  items.push({ separator: true });
  items.push({ label: 'Stash changes…', icon: 'plus', disabled: !changedFiles().length, action: askStashChanges });
  return items;
}

function stashMenuItems(hash) {
  const s = stashByHash(hash);
  if (!s) return [{ empty: 'This stash is gone' }];
  const ref = 'stash@{' + s.index + '}';
  return [
    { label: 'Apply', icon: 'check', sub: 'keep the stash', action: () => stashActionFor(hash, 'apply') },
    { label: 'Pop', icon: 'arrow-up', sub: 'apply, then drop', action: () => stashActionFor(hash, 'pop') },
    { label: 'Create branch from stash…', icon: 'fork', action: () => stashBranchFor(hash) },
    { separator: true },
    { label: 'Copy name', icon: 'copy', action: () => copyWithToast(ref, ref) },
    { separator: true },
    { label: 'Drop…', icon: 'trash', destructive: true, action: () => askDropStash(hash) },
  ];
}

function stashActionFor(hash, action) {
  const s = stashByHash(hash);
  if (!s) return;
  if (action === 'drop') askDropStash(hash);
  else runStashAction(s, action, false);
}

/* By index AND hash: indexes shift as stashes come and go, and the route
   refuses rather than acting on whichever stash now holds the number. */
function runStashAction(s, action, quiet) {
  if (anyBusy()) return;
  setBusy('stash', true);
  request({ command: 'stashAction', action, index: s.index, hash: s.hash }, 'stashAction', (result) => {
    setBusy('stash', false);
    if (!result.ok) { showActionError('Could not ' + action + ' the stash', result.error); return; }
    const what = action === 'apply' ? 'Stash applied' : action === 'pop' ? 'Stash applied and dropped' : 'Stash dropped';
    if (result.data && result.data.indexRestored === false) {
      showToast(what, { kind: 'warning', description: 'Its staged changes no longer fit the index, so they came back unstaged.' });
    } else if (!quiet) {
      showToast(what, { kind: 'success' });
    }
  });
}

function askDropStash(hash) {
  const s = stashByHash(hash);
  if (!s) return;
  const message = stashParts(s.message).message;
  showDialog({
    title: 'Drop “' + (message || 'stash@{' + s.index + '}') + '”?',
    message: 'The stash is deleted for good: nothing in PPM can bring it back.',
    destructive: true,
    confirmLabel: 'Drop stash',
    onConfirm: () => runStashAction(s, 'drop', false),
  });
}

function stashBranchFor(hash) {
  const s = stashByHash(hash);
  if (!s) return;
  const ref = 'stash@{' + s.index + '}';
  showDialog({
    title: 'Create a branch from ' + ref,
    message: 'The branch starts at the commit the stash was made on, with the stash applied to it. The stash is dropped once it applies cleanly.',
    input: { placeholder: 'Branch name' },
    confirmLabel: 'Create branch',
    onConfirm: (value) => {
      const name = String(value || '').trim();
      // By index and hash, as every other stash action is.
      if (name) runGitWrite('stashBranch', { name, index: s.index, hash: s.hash }, 'Created ' + name + ' from the stash', 'Could not create ' + name);
    },
  });
}

function askStashChanges() {
  const files = changedFiles();
  if (!files.length) { showToast('Nothing to stash'); return; }
  showDialog({
    title: 'Stash changes',
    message: 'Puts every change, staged or not, aside in a new stash and takes the working tree back to the last commit.',
    input: { placeholder: 'Message (optional)' },
    checkbox: { label: 'Include untracked files', checked: true },
    confirmLabel: 'Stash',
    onConfirm: (message, untracked) => stashChanges(String(message || '').trim(), !!untracked),
  });
}

function stashChanges(message, includeUntracked) {
  if (anyBusy()) return;
  const n = changedFiles().length;
  setBusy('stash', true);
  request({ command: 'stash', message: message || undefined, includeUntracked }, 'stash', (result) => {
    setBusy('stash', false);
    if (!result.ok) { showActionError('Could not stash', result.error); return; }
    const top = result.data;
    showToast('Stashed ' + plural(n, 'file'), {
      undo: top && top.hash ? () => runStashAction({ index: top.index, hash: top.hash }, 'pop', true) : null,
    });
  });
}

// --- Worktrees and submodules ---
function worktreeMenuItems() {
  const items = [{ heading: 'Worktrees' }];
  if (!state.worktrees.length) items.push({ empty: 'No worktrees' });
  state.worktrees.forEach((wt) => {
    const current = wt.path === state.repo;
    const name = wt.path.split(/[\\/]/).filter(Boolean).pop() || wt.path;
    const branch = wt.branch || (wt.isDetached ? 'detached at ' + String(wt.head || '').slice(0, 7) : '');
    const flags = [current ? 'this one' : '', wt.isMain && !current ? 'main' : '', wt.locked ? 'locked' : '', wt.prunable ? 'stale' : ''].filter(Boolean);
    const children = [];
    if (!current) children.push({ label: 'Open in PPM', icon: 'external', action: () => vscode.postMessage({ command: 'openWorktree', path: wt.path }) });
    children.push({ label: 'Copy path', icon: 'copy', action: () => copyWithToast(wt.path, 'the path') });
    if (!wt.isMain && !current) children.push({ separator: true }, { label: 'Remove…', icon: 'trash', destructive: true, action: () => askRemoveWorktree(wt) });
    items.push({ label: name, icon: current ? 'check' : 'folder', row2: [branch].concat(flags).filter(Boolean).join(' · '), title: wt.path, children });
  });
  items.push({ separator: true });
  items.push({ label: 'Add worktree…', icon: 'plus', action: () => showCreateWorktreeDialog() });
  items.push({ label: 'Prune stale entries…', icon: 'trash', action: askPruneWorktrees });
  return items;
}

function askRemoveWorktree(wt, force) {
  showDialog({
    title: force ? 'Remove it with its changes?' : 'Remove the worktree at ' + wt.path + '?',
    message: force
      ? 'It has changes that are not committed. Removing it anyway deletes them, and PPM keeps no copy.'
      : 'Its folder is deleted. The branch it has checked out stays.',
    destructive: true,
    confirmLabel: force ? 'Remove with changes' : 'Remove worktree',
    onConfirm: () => request({ command: 'removeWorktree', path: wt.path, force: !!force }, 'removeWorktree', (result) => {
      if (result.ok) { showToast('Removed the worktree at ' + wt.path, { kind: 'success' }); return; }
      if (!force && /--force|modified or untracked/.test(String(result.error))) { askRemoveWorktree(wt, true); return; }
      showActionError('Could not remove the worktree', result.error);
    }),
  });
}

function askPruneWorktrees() {
  showDialog({
    title: 'Prune stale worktrees?',
    message: 'Removes the entries of worktrees whose folders no longer exist. Nothing on disk is touched.',
    confirmLabel: 'Prune',
    onConfirm: () => request({ command: 'pruneWorktrees' }, 'pruneWorktrees', (result) => {
      if (result.ok) showToast('Pruned stale worktree entries', { kind: 'success' });
      else showActionError('Could not prune', result.error);
    }),
  });
}

/* Built by hand rather than with showDialog: it needs two fields and a choice
   between them, which the one-field dialog has no shape for. */
function showCreateWorktreeDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const base = String(state.repo || '').replace(/[\\/]+$/, '');
  dialog.innerHTML = '<div class="grab"></div><h3><span>Add worktree</span></h3>'
    + '<p>A second checkout of this repository in a folder of its own.</p>'
    + '<input type="text" data-f="path" aria-label="Folder for the worktree" placeholder="Folder for the worktree">'
    + '<div class="radios" role="radiogroup" aria-label="Branch">'
    + '<label><input type="radio" name="wt-mode" value="new" checked>New branch</label>'
    + '<label><input type="radio" name="wt-mode" value="existing">Existing branch</label></div>'
    + '<input type="text" data-f="branch" aria-label="Branch name" placeholder="Branch name">'
    + '<input type="text" data-f="start" aria-label="Start point" placeholder="Start at (commit or branch, optional)">'
    + '<div class="dialog-actions"><button type="button" class="btn outline" data-f="cancel">Cancel</button>'
    + '<button type="button" class="btn primary" data-f="ok">Add worktree</button></div>';
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  const field = (f) => dialog.querySelector('[data-f="' + f + '"]');
  if (base) field('path').value = base + '-worktree';
  const close = () => overlay.remove();
  const submit = () => {
    const path = field('path').value.trim();
    if (!path) { field('path').focus(); return; }
    const mode = dialog.querySelector('input[name="wt-mode"]:checked').value;
    const branch = field('branch').value.trim();
    const start = field('start').value.trim();
    const msg = { command: 'addWorktree', path };
    if (branch && mode === 'new') msg.newBranch = branch;
    else if (branch) msg.branch = branch;
    // A worktree on an existing branch starts wherever that branch is.
    if (start && !(branch && mode === 'existing')) msg.startPoint = start;
    close();
    request(msg, 'addWorktree', (result) => {
      if (result.ok) showToast('Added a worktree at ' + path, { kind: 'success' });
      else showActionError('Could not add the worktree', result.error);
    });
  };
  field('cancel').addEventListener('click', close);
  field('ok').addEventListener('click', submit);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type === 'text') { e.preventDefault(); submit(); }
  });
  setTimeout(() => { const p = field('path'); p.focus(); p.select(); }, 30);
}

function submoduleMenuItems() {
  const said = { current: 'up to date', uninitialized: 'not checked out', modified: 'not at the recorded commit', conflicted: 'has merge conflicts' };
  const items = [{ heading: 'Submodules' }];
  if (!state.submodules.length) items.push({ empty: 'No submodules' });
  state.submodules.forEach((sm) => {
    const name = sm.path.split('/').pop() || sm.path;
    const children = [{ label: 'Update to the recorded commit', icon: 'pull', action: () => updateSubmodules([sm]) }];
    if (sm.state !== 'uninitialized') children.push({ label: 'Open in PPM', icon: 'external', action: () => vscode.postMessage({ command: 'openSubmodule', path: sm.path }) });
    items.push({ label: name, icon: sm.state === 'current' ? 'cube' : 'warn', row2: sm.path + ' · ' + (said[sm.state] || sm.state), children });
  });
  items.push({ separator: true });
  items.push({
    label: 'Update all…', icon: 'pull', disabled: !state.submodules.length,
    action: () => showDialog({
      title: 'Update every submodule?',
      message: 'Each submodule checks out the commit this repository records for it. Changes inside them stay, but what they have checked out moves.',
      confirmLabel: 'Update all',
      onConfirm: () => updateSubmodules(state.submodules),
    }),
  });
  return items;
}

function updateSubmodules(list) {
  list.forEach((sm) => request({ command: 'updateSubmodule', path: sm.path }, 'updateSubmodule', (result) => {
    if (result.ok) showToast('Updated ' + sm.path, { kind: 'success' });
    else showActionError('Could not update ' + sm.path, result.error);
  }));
}

// --- Commits ---
/** Local branches pointing at a commit, the checked-out one included. */
function localBranchesAt(commit) {
  return (commit && commit.refs ? commit.refs : [])
    .filter((r) => r.type === 'head' || (r.type !== 'tag' && r.type !== 'stash' && !isRemoteBranchName(r.name)))
    .map((r) => r.name);
}

function prConfigured() {
  return !!(state.settings.prCreation && state.settings.prCreation.urlTemplate);
}

/** A commit's menu. full: the row's, with the three actions the inspector has as buttons. */
function commitMenuItems(commit, full) {
  const hash = commit.hash;
  const isHead = hash === state.head;
  const branch = currentName();
  const merge = (commit.parents || []).length > 1;
  const items = [];
  if (full) {
    items.push(
      { label: 'Checkout', icon: 'checkout', disabled: isHead, action: () => checkoutCommit(hash) },
      { label: 'Create branch here…', icon: 'fork', action: () => createBranchAt(hash) },
      { label: 'Cherry-pick', icon: 'cherry', disabled: isHead, action: () => cherryPick(hash) },
      { separator: true },
    );
  }
  items.push(
    { label: 'Revert…', icon: 'revert', disabled: merge, title: merge ? 'Reverting a merge needs a parent picked, which this menu does not offer' : '', action: () => revertCommit(commit) },
    { label: 'Create tag…', icon: 'tag', action: () => createTagAt(hash) },
    { label: 'Compare with HEAD', icon: 'compare', disabled: isHead, action: () => vscode.postMessage({ command: 'openCompare', ref1: hash, ref2: 'HEAD' }) },
    { separator: true },
    { label: 'Copy hash', icon: 'copy', kb: COPY_KEYS, action: () => copyWithToast(hash, 'the hash') },
    { label: 'Copy subject', icon: 'copy', action: () => copyWithToast(firstLine(commit.message), 'the subject') },
  );
  if (state.remoteWeb) {
    const web = state.remoteWeb;
    items.push({ label: 'Open on ' + web.label, icon: 'external', action: () => openExternal(web.base + web.commitPath + hash) });
  }
  const prBranch = prConfigured() ? localBranchesAt(commit)[0] : null;
  if (prBranch) items.push({ label: 'Create pull request (' + prBranch + ')', icon: 'pr', action: () => openPrUrl(prBranch) });
  items.push(
    { separator: true },
    { label: 'Reset ' + branch + ' to here…', icon: 'reset', destructive: true, disabled: isHead, action: () => promptResetMode(hash) },
  );
  return items;
}

function showRowMenu(commit, anchor) {
  if (commit._isWip) openMenu(wipMenuItems(), anchor);
  else if (commit._isStash) openMenu(stashMenuItems(commit.hash), anchor);
  else openMenu(commitMenuItems(commit, true), anchor);
}

/*
 * Checking out a commit means its branch, when it has one: a detached HEAD is
 * the one outcome nobody asks for by accident, so it is only reached by
 * saying so.
 */
function checkoutCommit(hash, anchor) {
  const commit = findCommit(hash);
  const names = localBranchesAt(commit).filter((n) => n !== state.currentBranch);
  if (names.length === 1) { checkoutRef(names[0], 'local'); return; }
  if (names.length > 1) {
    const items = [{ heading: 'Check out which branch?' }]
      .concat(names.map((n) => ({ label: n, icon: 'branch', action: () => checkoutRef(n, 'local') })));
    items.push({ separator: true }, { label: 'The commit itself (detached)', icon: 'commit', action: () => askDetached(hash) });
    openMenu(items, anchor || rowFor(hash) || null);
    return;
  }
  askDetached(hash);
}

function askDetached(target, label) {
  const name = label || String(target).slice(0, 7);
  showDialog({
    title: 'Check out ' + name + ' without a branch?',
    message: 'HEAD will point at the commit itself. Commits made there belong to no branch until you create one.',
    confirmLabel: 'Check out',
    onConfirm: () => runGitWrite('checkout', { target }, 'Switched to ' + name, 'Could not check out ' + name),
  });
}

function checkoutRef(name, type) {
  if (type === 'head' || name === state.currentBranch) { showToast('Already on ' + name); return; }
  if (type === 'tag') { askDetached(name, name); return; }
  if (type === 'remote') {
    // The local name: git makes it a branch tracking this one, where checking
    // out the remote name itself would detach HEAD.
    const prefix = remotePrefixes().find((p) => name.startsWith(p)) || '';
    const local = name.slice(prefix.length);
    runGitWrite('checkout', { target: local }, 'Switched to ' + local, 'Could not check out ' + local);
    return;
  }
  runGitWrite('checkout', { target: name }, 'Switched to ' + name, 'Could not check out ' + name);
}

function createBranchAt(hash) {
  showDialog({
    title: 'Create a branch at ' + String(hash).slice(0, 7),
    input: { placeholder: 'Branch name' },
    checkbox: { label: 'Check it out', checked: true },
    confirmLabel: 'Create branch',
    onConfirm: (value, checkout) => {
      const name = String(value || '').trim();
      if (name) runCreateBranch(name, hash, !!checkout, false);
    },
  });
}

function runCreateBranch(name, hash, checkout, force) {
  if (anyBusy()) return;
  setBusy('createBranch', true);
  gitAction('createBranch', { name, startPoint: hash, force }, (result) => {
    setBusy('createBranch', false);
    if (!result.ok) {
      if (!force && /already exists/.test(String(result.error))) {
        showDialog({
          title: 'Replace the branch ' + name + '?',
          message: 'A branch named ' + name + ' already exists. Replacing it moves it to ' + String(hash).slice(0, 7) + '; commits only it pointed at are left without a branch.',
          destructive: true,
          confirmLabel: 'Replace branch',
          onConfirm: () => runCreateBranch(name, hash, checkout, true),
        });
        return;
      }
      showActionError('Could not create ' + name, result.error);
      return;
    }
    if (checkout) runGitWrite('checkout', { target: name }, 'Created and switched to ' + name, 'Created ' + name + ', but could not check it out');
    else showToast('Created ' + name, { kind: 'success' });
  });
}

function cherryPick(hash) {
  const commit = findCommit(hash);
  const short = String(hash).slice(0, 7);
  if (commit && commit.parents.length > 1) {
    showToast('A merge cannot be cherry-picked from here', { description: 'git needs to be told which parent to pick it against.' });
    return;
  }
  runGitWrite('cherryPick', { hash }, 'Cherry-picked ' + short + ' onto ' + currentName(), 'Could not cherry-pick ' + short);
}

function revertCommit(commit) {
  const short = commit.hash.slice(0, 7);
  showDialog({
    title: 'Revert ' + short + '?',
    message: 'This makes a new commit on ' + currentName() + ' that undoes “' + firstLine(commit.message) + '”. The original commit stays in the history.',
    confirmLabel: 'Revert',
    onConfirm: () => runGitWrite('revert', { hash: commit.hash }, 'Reverted ' + short, 'Could not revert ' + short),
  });
}

function createTagAt(hash) {
  const short = String(hash).slice(0, 7);
  showDialog({
    title: 'Create a tag at ' + short,
    input: { placeholder: 'Tag name' },
    confirmLabel: 'Create tag',
    onConfirm: (value) => {
      const name = String(value || '').trim();
      if (name) runGitWrite('createTag', { name, hash }, 'Tagged ' + short + ' as ' + name, 'Could not create the tag');
    },
  });
}

function askRebase(target, label) {
  const branch = currentName();
  showDialog({
    title: 'Rebase ' + branch + ' onto ' + label + '?',
    message: 'The commits on ' + branch + ' are replayed on top of ' + label + ', which rewrites them. If they are already pushed, the next push has to be forced.',
    confirmLabel: 'Rebase',
    onConfirm: () => runGitWrite('rebase', { branch: target }, 'Rebased ' + branch + ' onto ' + label, 'Could not rebase'),
  });
}

function askMerge(name) {
  const into = currentName();
  showDialog({
    title: 'Merge ' + name + ' into ' + into + '?',
    message: 'git makes a merge commit, unless ' + into + ' can simply move forward to ' + name + '.',
    confirmLabel: 'Merge',
    onConfirm: () => runGitWrite('merge', { branch: name }, 'Merged ' + name + ' into ' + into, 'Could not merge ' + name),
  });
}

function promptResetMode(hash) {
  const branch = currentName();
  const short = String(hash).slice(0, 7);
  const done = 'Reset ' + branch + ' to ' + short;
  showDialog({
    title: 'Reset ' + branch + ' to ' + short + '?',
    message: 'soft keeps what the later commits changed, staged. mixed keeps it unstaged. hard throws it away, and every uncommitted change with it.',
    select: { options: ['soft', 'mixed', 'hard'], defaultValue: 'mixed', label: 'Mode' },
    destructive: true,
    confirmLabel: 'Reset',
    onConfirm: (mode) => {
      if (mode !== 'hard') { runGitWrite('reset', { mode, hash }, done, 'Could not reset'); return; }
      showDialog({
        title: 'Throw away every change since ' + short + '?',
        message: 'A hard reset deletes uncommitted work in every tracked file, and PPM keeps no copy of it. The commits after ' + short + ' can still be found in the reflog.',
        destructive: true,
        confirmLabel: 'Reset hard',
        onConfirm: () => runGitWrite('reset', { mode: 'hard', hash }, done, 'Could not reset'),
      });
    },
  });
}

// --- Refs ---
function showRefMenu(name, type, commit, anchor) {
  openMenu(refMenuItems(name, type), anchor);
}

function refMenuItems(name, type) {
  const current = currentName();
  const items = [];
  if (type === 'head' || type === 'local') {
    const isHead = type === 'head' || name === state.currentBranch;
    items.push(
      { label: isHead ? 'Checked out' : 'Checkout', icon: 'checkout', disabled: isHead, action: () => checkoutRef(name, type) },
      { label: 'Merge into ' + current, icon: 'merge', disabled: isHead, action: () => askMerge(name) },
      { label: 'Rebase ' + current + ' onto this', icon: 'rebase', disabled: isHead, action: () => askRebase(name, name) },
      { separator: true },
      { label: 'Rename…', icon: 'edit', action: () => askRenameBranch(name) },
      { label: 'Delete…', icon: 'trash', destructive: true, disabled: isHead, title: isHead ? 'Check out another branch first' : '', action: () => askDeleteBranch(name) },
      { separator: true },
      { label: 'Compare with ' + current, icon: 'compare', disabled: isHead, action: () => vscode.postMessage({ command: 'openCompare', ref1: name, ref2: 'HEAD' }) },
      { label: 'Copy name', icon: 'copy', action: () => copyWithToast(name, 'the branch name') },
    );
    if (prConfigured()) items.push({ label: 'Create pull request', icon: 'pr', action: () => openPrUrl(name) });
  } else if (type === 'remote') {
    const prefix = remotePrefixes().find((p) => name.startsWith(p)) || '';
    const remote = prefix.slice(0, -1);
    const branch = name.slice(prefix.length);
    items.push(
      { label: 'Check out as a local branch', icon: 'checkout', action: () => checkoutRef(name, 'remote') },
      { label: 'Merge into ' + current, icon: 'merge', action: () => askMerge(name) },
      { label: 'Rebase ' + current + ' onto this', icon: 'rebase', action: () => askRebase(name, name) },
      { separator: true },
      { label: 'Compare with ' + current, icon: 'compare', action: () => vscode.postMessage({ command: 'openCompare', ref1: name, ref2: 'HEAD' }) },
      { label: 'Copy name', icon: 'copy', action: () => copyWithToast(name, 'the branch name') },
      { separator: true },
      { label: 'Delete from ' + (remote || 'the remote') + '…', icon: 'trash', destructive: true, disabled: !remote, action: () => askDeleteRemoteBranch(remote, branch) },
    );
  } else if (type === 'tag') {
    items.push(
      { label: 'Checkout', icon: 'checkout', action: () => checkoutRef(name, 'tag') },
      { label: 'Compare with ' + current, icon: 'compare', action: () => vscode.postMessage({ command: 'openCompare', ref1: name, ref2: 'HEAD' }) },
      { label: 'Copy name', icon: 'copy', action: () => copyWithToast(name, 'the tag name') },
      { separator: true },
      { label: 'Delete tag…', icon: 'trash', destructive: true, action: () => askDeleteTag(name) },
    );
  }
  return items;
}

function askRenameBranch(name) {
  showDialog({
    title: 'Rename ' + name,
    input: { placeholder: 'New name', defaultValue: name },
    confirmLabel: 'Rename',
    onConfirm: (value) => {
      const next = String(value || '').trim();
      if (next && next !== name) runGitWrite('renameBranch', { oldName: name, newName: next }, 'Renamed ' + name + ' to ' + next, 'Could not rename ' + name);
    },
  });
}

function askDeleteBranch(name) {
  showDialog({
    title: 'Delete the branch ' + name + '?',
    message: 'Only the name goes: its commits stay wherever another branch contains them.',
    destructive: true,
    confirmLabel: 'Delete branch',
    onConfirm: () => deleteBranch(name, false),
  });
}

function deleteBranch(name, force) {
  if (anyBusy()) return;
  setBusy('deleteBranch', true);
  gitAction('deleteBranch', { name, force }, (result) => {
    setBusy('deleteBranch', false);
    if (result.ok) { showToast('Deleted ' + name, { kind: 'success' }); return; }
    if (!force && /not fully merged/.test(String(result.error))) {
      showDialog({
        title: name + ' is not merged',
        message: 'It has commits no other branch contains. Deleting it anyway leaves them reachable only through the reflog.',
        destructive: true,
        confirmLabel: 'Delete anyway',
        onConfirm: () => deleteBranch(name, true),
      });
      return;
    }
    showActionError('Could not delete ' + name, result.error);
  });
}

function askDeleteRemoteBranch(remote, branch) {
  showDialog({
    title: 'Delete ' + branch + ' from ' + remote + '?',
    message: 'The branch goes from the remote for everyone who uses it. Your local branch, if you have one, stays.',
    destructive: true,
    confirmLabel: 'Delete from ' + remote,
    onConfirm: () => runGitWrite('push', { remote, branch, delete: true }, 'Deleted ' + branch + ' from ' + remote, 'Could not delete ' + remote + '/' + branch),
  });
}

function askDeleteTag(name) {
  showDialog({
    title: 'Delete the tag ' + name + '?',
    message: 'Only the local tag goes. If it was pushed, the remote keeps its copy.',
    destructive: true,
    confirmLabel: 'Delete tag',
    onConfirm: () => runGitWrite('deleteTag', { name }, 'Deleted the tag ' + name, 'Could not delete ' + name),
  });
}

// --- Dragging a branch onto a commit ---
function makeRefDraggable(pill, refName, refType) {
  // Only branches can be merged or rebased; tags and stashes cannot.
  if (refType === 'tag' || refType === 'stash') return;
  pill.draggable = true;
  pill.addEventListener('dragstart', (e) => {
    dragRef = { name: refName, type: refType };
    pill.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', refName);
    e.stopPropagation();
  });
  pill.addEventListener('dragend', () => {
    dragRef = null;
    pill.classList.remove('dragging');
    document.querySelectorAll('.commit-row.drop-target').forEach((r) => r.classList.remove('drop-target'));
  });
}

function makeRowDropTarget(row, commit) {
  if (commit._isWip || commit._isStash) return;
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
    showDropActionMenu({ x: e.clientX, y: e.clientY }, dragRef, commit);
    dragRef = null;
  });
}

function showDropActionMenu(anchor, ref, commit) {
  const short = commit.hash.slice(0, 7);
  const current = currentName();
  const items = [];
  if (ref.name === state.currentBranch) {
    // The checked-out branch dropped on a commit: move this branch there.
    items.push({ label: 'Rebase ' + ref.name + ' onto ' + short, icon: 'rebase', action: () => askRebase(commit.hash, short) });
  } else {
    items.push({ label: 'Merge ' + ref.name + ' into ' + current, icon: 'merge', action: () => askMerge(ref.name) });
    items.push({ label: 'Rebase ' + current + ' onto ' + ref.name, icon: 'rebase', action: () => askRebase(ref.name, ref.name) });
  }
  items.push({ separator: true });
  items.push({ label: 'Compare ' + ref.name + ' with ' + short, icon: 'compare', action: () => vscode.postMessage({ command: 'openCompare', ref1: ref.name, ref2: commit.hash }) });
  openMenu(items, anchor);
}

// --- Files ---
function openReview(path) {
  vscode.postMessage(path ? { command: 'openReview', path } : { command: 'openReview' });
}

function openFile(path) {
  vscode.postMessage({ command: 'openFile', filePath: path });
}

/** A file in a commit's or a stash's list. */
function commitFileMenuItems(path, hash, parent) {
  const short = String(hash).slice(0, 7);
  return [
    { label: 'Open diff', icon: 'file-diff', action: () => vscode.postMessage({ command: 'openDiff', filePath: path, hash, parentHash: parent || null }) },
    { label: 'Open file', icon: 'doc', action: () => openFile(path) },
    { separator: true },
    { label: 'Blame', icon: 'people', action: () => vscode.postMessage({ command: 'openBlame', filePath: path }) },
    { label: 'Blame at ' + short, icon: 'history', action: () => vscode.postMessage({ command: 'openBlame', filePath: path, hash }) },
    { label: 'File history', icon: 'history', action: () => vscode.postMessage({ command: 'openFileHistory', filePath: path }) },
    { separator: true },
    { label: 'Copy path', icon: 'copy', action: () => copyWithToast(path, 'the path') },
  ];
}

/** A changed file in the uncommitted view: Source Control's row menu. */
function wipFileMenuItems(f) {
  if (f.conflict) {
    return [
      { label: 'Resolve conflict', icon: 'merge', action: () => vscode.postMessage({ command: 'openConflictFile', filePath: f.path }) },
      { label: 'Open file', icon: 'doc', action: () => openFile(f.path) },
      { separator: true },
      { label: 'Mark as resolved', icon: 'check', action: () => markResolved(f) },
    ];
  }
  const check = fileCheckState(f);
  return [
    { label: 'Review changes', icon: 'file-diff', action: () => openReview(f.path) },
    { label: 'Open diff', icon: 'compare', action: () => vscode.postMessage({ command: 'openDiff', filePath: f.path, hash: 'uncommitted', parentHash: state.head || null }) },
    { label: 'Open file', icon: 'doc', disabled: changeLetter(f) === 'D', action: () => openFile(f.path) },
    { separator: true },
    { label: 'Stage file', icon: 'plus', disabled: check === 'all', action: () => stageFiles([f]) },
    { label: 'Unstage file', icon: 'minus', disabled: check === 'none', action: () => unstageFiles([f]) },
    { label: 'Discard changes…', icon: 'trash', destructive: true, disabled: !hasUnstaged(f), action: () => askDiscard([f]) },
    { separator: true },
    { label: 'Copy path', icon: 'copy', action: () => copyWithToast(f.path, 'the path') },
  ];
}

function wipMenuItems() {
  const files = changedFiles();
  const discardable = files.filter(hasUnstaged);
  const untracked = files.filter((f) => f.untracked && !f.conflict);
  return [
    { label: 'Stash all changes', icon: 'stash', disabled: !files.length, action: () => stashChanges('', true) },
    { label: 'Review changes', icon: 'file-diff', disabled: !files.length, action: () => openReview() },
    { separator: true },
    { label: 'Discard all changes…', icon: 'trash', destructive: true, disabled: !discardable.length, action: () => askDiscard(discardable) },
    {
      label: 'Delete untracked files…', icon: 'trash', destructive: true, disabled: !untracked.length,
      action: () => askDiscard(untracked, untracked.length === 1 ? null : {
        title: 'Delete ' + plural(untracked.length, 'untracked file') + '?',
        body: 'They are files git has never stored. You can undo it right after.',
        confirm: 'Delete ' + plural(untracked.length, 'file'),
      }),
    },
    { label: 'Reset…', icon: 'reset', destructive: true, disabled: !files.length, action: askResetWorkingTree },
  ];
}

function askResetWorkingTree() {
  showDialog({
    title: 'Reset the uncommitted changes?',
    message: 'mixed unstages everything and leaves your files as they are. hard puts every tracked file back to the last commit, and PPM keeps no copy.',
    select: { options: ['mixed', 'hard'], defaultValue: 'mixed', label: 'Mode' },
    destructive: true,
    confirmLabel: 'Reset',
    onConfirm: (mode) => {
      if (mode !== 'hard') { runGitWrite('reset', { mode: 'mixed', hash: 'HEAD' }, 'Unstaged everything', 'Could not reset'); return; }
      showDialog({
        title: 'Throw away every uncommitted change?',
        message: 'Tracked files go back to the last commit. Discard does the same with an undo; this does not have one.',
        destructive: true,
        confirmLabel: 'Reset hard',
        onConfirm: () => runGitWrite('reset', { mode: 'hard', hash: 'HEAD' }, 'Reset to the last commit', 'Could not reset'),
      });
    },
  });
}

// --- Staging, discarding, committing ---
/* A second tick while the first is on the wire queues behind it rather than
   being dropped; only the commit button waits for both. */
function stageFiles(files) {
  const paths = files.map((f) => f.path);
  if (!paths.length) return;
  busyCount('stage', 1);
  request({ command: 'stageFiles', paths }, 'stageFiles', (result) => {
    busyCount('stage', -1);
    if (!result.ok) showActionError('Could not stage', result.error);
  });
}

function unstageFiles(files) {
  const paths = [];
  files.forEach((f) => unstagePaths(f).forEach((p) => paths.push(p)));
  if (!paths.length) return;
  busyCount('stage', 1);
  request({ command: 'unstageFiles', paths }, 'unstageFiles', (result) => {
    busyCount('stage', -1);
    if (!result.ok) showActionError('Could not unstage', result.error);
  });
}

/** Tick: stage the rest; untick once it is all staged. A conflict is only ever marked resolved. */
function toggleFile(f) {
  if (f.conflict) markResolved(f);
  else if (fileCheckState(f) === 'all') unstageFiles([f]);
  else stageFiles([f]);
}

function toggleAllFiles() {
  const files = changedFiles();
  if (allCheckState(files) === 'all') unstageFiles(files);
  else stageFiles(files.filter((f) => !f.conflict && fileCheckState(f) !== 'all'));
}

/* Staging a conflict is what marks it resolved, markers or not. Source Control
   reads the file to see if git's markers are still in it; the frame cannot,
   so it always asks. */
function markResolved(f) {
  showDialog({
    title: 'Mark ' + splitPath(f.path)[1] + ' as resolved?',
    message: 'This stages the file as it is now. If git’s conflict markers are still in it, they are committed too.',
    confirmLabel: 'Mark resolved',
    onConfirm: () => stageFiles([f]),
  });
}

function askDiscard(files, summary) {
  const list = (files || []).filter(hasUnstaged);
  if (!list.length) return;
  const s = summary || discardSummary(list);
  showDialog({
    title: s.title,
    message: s.body,
    destructive: true,
    confirmLabel: s.confirm,
    onConfirm: () => discardFiles(list),
  });
}

function discardFiles(files) {
  if (anyBusy()) return;
  const what = files.length === 1 ? splitPath(files[0].path)[1] : plural(files.length, 'file');
  setBusy('discard', true);
  request({ command: 'discardFiles', paths: files.map((f) => f.path) }, 'discardFiles', (result) => {
    setBusy('discard', false);
    if (!result.ok) { showActionError('Could not discard', result.error); return; }
    const record = result.data && result.data.undo;
    if (!record) return;
    // Undo brings back what was kept, and nothing else: a file too large to copy is gone
    // for good, so a discard that kept nothing offers no Undo at all.
    const kept = record.paths || [];
    if (kept.length) {
      const keptWhat = kept.length === 1 ? splitPath(kept[0])[1] : plural(kept.length, 'file');
      showToast('Discarded changes to ' + what, { duration: 8000, undo: () => undoDiscard(record.id, keptWhat) });
    }
    if (record.skipped && record.skipped.length) {
      showToast(record.skipped.join(', ') + ' could not be kept, so it cannot be restored', {
        kind: 'warning', description: 'Files over 20 MB are discarded without a copy.',
      });
    }
  });
}

function undoDiscard(id, what) {
  setBusy('undo', true);
  request({ command: 'undoDiscard', id }, 'undoDiscard', (result) => {
    setBusy('undo', false);
    if (result.ok) showToast('Restored ' + what, { kind: 'success' });
    else showActionError('Could not undo the discard', result.error);
  });
}

/** What the composer may do right now — git-commit-composer.tsx's rules. */
function composerState() {
  const ta = document.getElementById('commit-message');
  const message = ta ? ta.value : (state.draft.message || '');
  const totals = changeTotals(changedFiles());
  const last = state.changes && state.changes.lastCommit;
  const busy = anyBusy();
  // Both rewrite the last commit, so neither is offered once it is on the remote.
  const rewritable = !!last && !last.pushed;
  return {
    message, totals,
    ready: canCommit(totals, message) && !busy,
    amendable: rewritable && !busy && (totals.filesStaged > 0 || message.trim() !== ''),
    undoable: rewritable && !!last.hasParent && !busy,
  };
}

function commitSplitItems() {
  const s = composerState();
  const last = state.changes && state.changes.lastCommit;
  return [
    { label: 'Commit and push', icon: 'push', disabled: !s.ready, action: () => commitStaged({ push: true }) },
    { label: 'Amend last commit', icon: 'edit', disabled: !s.amendable, action: () => commitStaged({ amend: true }) },
    { label: 'Commit with sign-off', icon: 'check', disabled: !s.ready, action: () => commitStaged({ signoff: true }) },
    { separator: true },
    { label: 'Undo last commit', icon: 'undo', disabled: !s.undoable, action: () => undoLastCommit(last && last.hash) },
  ];
}

/* After a commit of the text committed. Text typed in while its hooks ran is
   the next message, and stays. */
function clearComposer(committed) {
  const ta = document.getElementById('commit-message');
  if (ta && ta.value.trim() !== committed) { updateCommitControls(); return; }
  state.draft = { message: '', updatedAt: null };
  state.draftEditedAt = 0;
  if (ta) ta.value = '';
  updateCommitControls();
}

function commitStaged(opts) {
  opts = opts || {};
  const s = composerState();
  if (opts.amend ? !s.amendable : !s.ready) return;
  // A save still waiting to go out would land after the commit cleared the
  // message and put the committed text back.
  clearTimeout(draftTimer);
  const before = branchState();
  const filesStaged = s.totals.filesStaged;
  const message = s.message.trim();
  setBusy('commit', true);
  request({ command: 'commitStaged', message, amend: !!opts.amend, signoff: !!opts.signoff, push: !!opts.push }, 'commitStaged', (result) => {
    setBusy('commit', false);
    if (!result.ok) {
      const text = String(result.error || '');
      // The commit stands even when the push after it fails.
      if (/^Committed, but the push failed/.test(text)) {
        clearComposer(message);
        showToast('Push failed', { kind: 'error', description: text });
        return;
      }
      showActionError(opts.amend ? 'Could not amend the commit' : 'Could not commit', text);
      return;
    }
    clearComposer(message);
    const data = result.data || {};
    const short = String(data.hash || '').slice(0, 7);
    // Undo takes a commit back whole, which for an amend is more than the amend.
    if (opts.amend) showToast('Amended ' + short, { kind: 'success' });
    else showToast('Committed ' + short + ' · ' + plural(filesStaged, 'file'), { undo: () => undoLastCommit(data.hash) });
    if (opts.push && data.pushed && before) {
      if (syncMode(before) === 'publish') showToast('Published ' + (before.head || 'the branch') + ' to the remote', { kind: 'success' });
      else showToast('Pushed ' + plural((before.ahead || 0) + 1, 'commit') + ' to ' + (before.upstream || 'the remote'), { kind: 'success' });
    }
  });
}

/** Undo the commit with this hash: PPM refuses once it is no longer the last one. */
function undoLastCommit(hash) {
  if (anyBusy()) return;
  setBusy('undoCommit', true);
  request({ command: 'undoCommit', hash }, 'undoCommit', (result) => {
    setBusy('undoCommit', false);
    if (!result.ok) { showActionError('Could not undo the commit', result.error); return; }
    // The server put the undone commit's message back, if the box was empty.
    const draft = result.data && result.data.draft;
    const ta = document.getElementById('commit-message');
    if (draft && draft.message) {
      state.draft = draft;
      state.draftEditedAt = 0;
      if (ta && !ta.value.trim()) ta.value = draft.message;
    }
    updateCommitControls();
    showToast('Commit undone — its changes are staged again');
  });
}

// --- A merge, rebase or cherry-pick that stopped ---
function renderOpBanner() {
  const banner = document.getElementById('op-banner');
  const op = state.changes && state.changes.operation;
  if (!op) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
  const conflicts = changedFiles().filter((f) => f.conflict).length;
  const branch = (state.changes.branch && state.changes.branch.head) || null;
  const busy = anyBusy();
  const off = busy ? ' disabled' : '';
  banner.classList.remove('hidden');
  banner.innerHTML = ic('warn') + '<div class="txt"><b>' + escHtml(operationTitle(op, branch)) + '</b><span>'
    + escHtml(conflicts ? plural(conflicts, 'conflict') + ' left to resolve' : 'All conflicts resolved — continue when ready') + '</span></div>'
    + '<div class="acts">'
    + (conflicts ? '<button type="button" class="btn xs outline" data-op="resolve">' + ic('merge', 'ic-sm') + 'Resolve</button>' : '')
    + '<button type="button" class="btn xs outline" data-op="abort"' + off + '>Abort</button>'
    + (op.kind === 'rebase' ? '<button type="button" class="btn xs outline" data-op="skip"' + off + ' title="Leave this commit out and go on with the next">Skip</button>' : '')
    + '<button type="button" class="btn xs primary" data-op="continue"' + (busy || conflicts ? ' disabled' : '')
    + (conflicts ? ' title="Resolve every conflict first"' : '') + '>Continue</button>'
    + '</div>';
}

function runOperation(action, noun) {
  if (anyBusy()) return;
  const name = 'operation:' + action;
  setBusy(name, true);
  request({ command: 'operation', action }, name, (result) => {
    setBusy(name, false);
    if (!result.ok) { showActionError('Could not ' + action + ' the ' + noun, result.error); return; }
    if (action === 'continue') showToast('The ' + noun + ' is finished', { kind: 'success' });
  });
}

{
  document.getElementById('op-banner').addEventListener('click', (e) => {
    const b = e.target.closest('[data-op]');
    const op = state.changes && state.changes.operation;
    if (!b || b.disabled || !op) return;
    const noun = operationNoun(op.kind);
    switch (b.dataset.op) {
      case 'resolve': {
        // One conflict opens straight away; several are listed in the inspector.
        const conflicts = changedFiles().filter((f) => f.conflict);
        if (conflicts.length === 1) vscode.postMessage({ command: 'openConflictFile', filePath: conflicts[0].path });
        else selectCommit('uncommitted', { scroll: true });
        break;
      }
      case 'abort':
        showDialog({
          title: 'Abort the ' + noun + '?',
          message: 'This puts the branch back where it was before the ' + noun + ' started. Conflicts you resolved so far are lost.',
          destructive: true,
          confirmLabel: 'Abort ' + noun,
          onConfirm: () => runOperation('abort', noun),
        });
        break;
      case 'skip': runGitWrite('rebaseSkip', {}, 'Skipped that commit', 'Could not skip the commit'); break;
      case 'continue': runOperation('continue', noun); break;
    }
  });
}

// --- The status bar ---
function updateStatus() {
  const n = state.commits.length;
  const branches = localBranchNames().length;
  const parts = [
    state.hasMore ? n + ' commits loaded' : plural(n, 'commit'),
    branches + (branches === 1 ? ' branch' : ' branches'),
    plural(state.tags.length, 'tag'),
  ];
  document.getElementById('status-text').textContent = state.commitsLoaded ? parts.join(' · ') : 'Loading repository…';
  document.getElementById('btn-load-more').classList.toggle('hidden', !state.hasMore);
}
`;
}
