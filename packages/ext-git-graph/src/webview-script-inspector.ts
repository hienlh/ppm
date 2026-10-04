/**
 * The Git Graph script's inspector: what the selected row is — a commit, a
 * stash, or the uncommitted changes with the same composer and file rows as
 * Source Control. A column beside the list on a wide panel, a panel over it
 * on a narrow one, a bottom sheet on a phone; the stylesheet decides which.
 *
 * Everything in here is built as markup from repository data, so every field
 * goes through escHtml on its way in — commit-detail-escaping.test.ts checks
 * the renderers for a raw interpolation.
 *
 * Part of one shared script; see webview-script-core.ts for the rules.
 */
export function inspectorScript(): string {
  return String.raw`
// --- Detail cells ---

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

function whenCell(ts) {
  const when = new Date(ts * 1000);
  return '<span class="meta-when">' + escHtml(when.toLocaleString(undefined, WHEN_FORMAT)) + '</span>';
}

/* One label, one value, every row the same shape. */
function metaRow(label, cells) {
  return '<div class="meta-label">' + escHtml(label) + '</div>'
    + '<div class="meta-cells">' + cells.join('') + '</div>';
}

/* A cap that does not say it capped states a wrong number as a fact: a commit
   touching ten thousand files rendered as "500 files changed", which is a
   sentence the panel has no evidence for. */
function fileCountLabel(shown, omitted) {
  return shown + (shown === 1 ? ' file' : ' files') + ' changed'
    + (omitted > 0 ? ' [… ' + omitted + ' more]' : '');
}

const STATUS_NAMES = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict' };

function statusTile(letter) {
  const s = escHtml(letter);
  return '<span class="st st-' + s + '" title="' + escHtml(STATUS_NAMES[letter] || letter) + '">' + s + '</span>';
}

/*
 * The app's own file icons, the ones every other file list in PPM draws. They live in a
 * stylesheet this frame cannot reach, so the panel names the files it shows and the app
 * answers with each one's class and the drawings of just those classes. Until it has, an
 * icon is an empty 16px box, as it is in the app while that stylesheet loads.
 */
const fileIconClasses = new Map();
const fileIconsAsked = new Set();
// Two names can share a drawing (every .ts file), and each answer carries it again.
const fileIconRulesAdded = new Set();

function fileIconHtml(path) {
  const name = splitPath(String(path))[1];
  const cls = fileIconClasses.get(name);
  return '<span class="vsi' + (cls ? ' ' + cls : '') + '" data-fi="' + escHtml(name) + '" aria-hidden="true"></span>';
}

/** Asks the app for the icons of the files just drawn that it has not been asked about. */
function requestFileIcons() {
  const names = [];
  document.querySelectorAll('#detail-panel [data-fi]').forEach((el) => {
    const name = el.dataset.fi;
    if (fileIconClasses.has(name) || fileIconsAsked.has(name)) return;
    fileIconsAsked.add(name);
    names.push(name);
  });
  if (names.length) vscode.postMessage({ command: '__ppm.fileIcons', names });
}

function receiveFileIcons(msg) {
  (msg.icons || []).forEach((pair) => fileIconClasses.set(pair[0], pair[1]));
  let css = '';
  (msg.rules || []).forEach((pair) => {
    if (fileIconRulesAdded.has(pair[0])) return;
    fileIconRulesAdded.add(pair[0]);
    css += pair[1];
  });
  if (css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }
  document.querySelectorAll('[data-fi]').forEach((el) => {
    const cls = fileIconClasses.get(el.dataset.fi);
    if (cls) el.className = 'vsi ' + cls;
  });
}

/* The name first, the folder under it, cut from the start: in a narrow column
   the part of a path that tells two files apart is its end. */
function nameAndDir(path) {
  const parts = splitPath(String(path));
  const name = escHtml(parts[1]);
  const dir = escHtml(parts[0]);
  return '<span class="nm"><b>' + name + '</b>' + (dir ? '<small class="sx"><bdi>' + dir + '</bdi></small>' : '') + '</span>';
}

/** A commit's or a stash's files: a click opens the diff, the arrow the file itself. */
function renderFileListHtml(files, hash, parentHash) {
  const h = escHtml(hash);
  const p = escHtml(parentHash || '');
  return files.map((f) => {
    const path = escHtml(f.path);
    return '<button type="button" class="gi-file" data-act="file" data-path="' + path + '" data-hash="' + h
      + '" data-parent="' + p + '" title="Open the diff of ' + path + '">'
      + fileIconHtml(f.path) + nameAndDir(f.path) + countsHtml(f.additions, f.deletions)
      + '<span class="open" data-act="file-open" title="Open the file">' + ic('external', 'ic-sm') + '</span>'
      + statusTile(f.status) + '</button>';
  }).join('');
}

function filesSectionHtml(detail) {
  const files = detail.fileChanges || [];
  let added = 0, removed = 0;
  for (const f of files) { added += f.additions || 0; removed += f.deletions || 0; }
  const omitted = detail.filesOmitted || 0;
  return '<div class="gi-sec">Files<span class="n">' + (files.length + omitted) + '</span><span class="grow"></span>'
    + '<span title="' + escHtml(fileCountLabel(files.length, omitted)) + '">' + countsHtml(added, removed) + '</span></div>'
    + (omitted ? '<div class="gi-note">' + escHtml(fileCountLabel(files.length, omitted)) + '</div>' : '')
    + renderFileListHtml(files, detail.hash, detail.parents[0] || '');
}

/* The body keeps the author's own breaks where they mean something: a
   paragraph wrapped at 72 columns is reflowed to the pane it is actually in,
   a list or an aligned block keeps every break it had. */
function messageBodyHtml(message) {
  const text = String(message || '');
  const firstBreak = text.indexOf('\n');
  const body = firstBreak === -1 ? '' : text.slice(firstBreak + 1).replace(/^\n+/, '').replace(/\s+$/, '');
  if (!body) return '';
  let blocks = '';
  for (const block of splitCommitBody(body)) {
    blocks += block.kind === 'prose'
      ? '<p class="msg-p">' + formatCommitMessage(block.text) + '</p>'
      : '<pre class="msg-pre">' + formatCommitMessage(block.text) + '</pre>';
  }
  return '<div class="gi-body">' + blocks + '</div>';
}

const CLOSE_BUTTON = '<button type="button" class="tool detail-close" title="Close (Esc)" aria-label="Close details">' + ic('x') + '</button>';

function moreButton(act) {
  return '<button type="button" class="tool more-top" data-act="' + act + '" title="More actions" aria-label="More actions">' + ic('more') + '</button>';
}

// --- Which view ---
function renderInspector(fallback) {
  const hash = state.selectedCommit;
  const panel = document.getElementById('detail-panel');
  if (!hash) {
    panel.dataset.view = 'empty';
    panel.innerHTML = '<div class="grab"></div><div class="gi-empty">' + ic('commit') + '<span>Select a commit to see what it changed</span></div>';
    return;
  }
  if (hash === 'uncommitted') { renderWipPanel(); return; }
  const commit = findCommit(hash) || fallback || null;
  const stash = stashByHash(hash);
  if (stash) {
    renderStashPanel(state.detail && state.detail.hash === hash ? state.detail : stashPlaceholder(stash));
    if (!state.detail || state.detail.hash !== hash) vscode.postMessage({ command: 'requestStashDetails', hash });
    return;
  }
  if (commit) renderDetailPanel(partialDetail(commit));
  else {
    panel.dataset.view = 'commit';
    panel.innerHTML = '<div class="grab"></div><div class="gi-empty">' + ic('spinner', 'spin') + '<span>Loading commit…</span></div>';
  }
  vscode.postMessage({ command: 'requestCommitDetails', hash });
}

/** What the row already knows, drawn at once; the files follow when git answers. */
function partialDetail(commit) {
  return {
    hash: commit.hash, parents: commit.parents || [],
    author: commit.author, authorEmail: commit.authorEmail, authorDate: commit.authorDate,
    committer: commit.committer, committerEmail: commit.committerEmail, commitDate: commit.commitDate,
    message: commit.message, fileChanges: null, filesOmitted: 0, _partial: true,
  };
}

function stashPlaceholder(stash) {
  return {
    hash: stash.hash, parents: stash.parentHash ? [stash.parentHash] : [],
    author: '', authorEmail: '', authorDate: 0, committer: '', committerEmail: '', commitDate: 0,
    message: stash.message, fileChanges: null, filesOmitted: 0, _partial: true,
  };
}

/** A commitDetails answer: drawn only if it is still the answer to the question. */
function receiveDetail(detail) {
  if (!detail || detail.hash !== state.selectedCommit) return;
  state.detail = detail;
  if (stashByHash(detail.hash)) renderStashPanel(detail);
  else renderDetailPanel(detail);
}

// --- A commit ---
function renderDetailPanel(detail) {
  const panel = document.getElementById('detail-panel');
  const keepScroll = panel.dataset.view === 'commit' && panel.dataset.hash === detail.hash ? panel.scrollTop : 0;
  const commit = findCommit(detail.hash);
  const isHead = detail.hash === state.head;
  const short = escHtml(String(detail.hash).slice(0, 7));
  const subject = firstLine(detail.message);
  const parentCount = detail.parents.length;
  const byOther = !!detail.committer && detail.committer !== detail.author;
  const pills = commit ? refPillsHtml(commit) : '';
  const parentLinks = detail.parents.map((p) => '<button type="button" class="hash" data-act="select" data-hash="' + escHtml(p)
    + '" title="Show this commit">' + escHtml(String(p).slice(0, 7)) + '</button>').join('');

  let head = '<div class="grab"></div><div class="gi-head"><div class="gi-top">'
    + avatarFor(detail.author, detail.authorEmail, true)
    + '<div class="gi-who"><b title="' + escHtml(detail.authorEmail) + '">' + escHtml(detail.author) + '</b>'
    + '<small title="' + escHtml(absDate(detail.authorDate)) + '">' + escHtml(longAgo(detail.authorDate))
    + (byOther ? ' · committed by ' + escHtml(detail.committer) : '') + '</small></div>'
    + '<span class="grow"></span>' + moreButton('commit-more') + CLOSE_BUTTON + '</div>'
    + '<h3 class="gi-subj">' + formatCommitMessage(subject) + '</h3>'
    + '<div class="gi-meta"><button type="button" class="hash" data-copy="' + escHtml(detail.hash) + '" title="Copy the full hash">' + ic('copy') + short + '</button>'
    + '<span>' + (parentCount > 1 ? 'parents' : parentCount ? 'parent' : 'root commit') + '</span>'
    + parentLinks
    + '</div>'
    + (pills ? '<div class="gi-refs">' + pills + '</div>' : '')
    + '<div class="gi-acts">'
    + '<button type="button" class="btn outline" data-act="checkout"' + (isHead ? ' disabled title="Already checked out"' : '') + '>' + ic('checkout') + '<span>Checkout</span></button>'
    + '<button type="button" class="btn outline" data-act="branch">' + ic('fork') + '<span>Branch…</span></button>'
    + '<button type="button" class="btn outline" data-act="cherry-pick"' + (isHead ? ' disabled title="This is the checked-out commit"' : '') + '>' + ic('cherry') + '<span>Cherry-pick</span></button>'
    + '<button type="button" class="btn outline more-act" data-act="commit-more">' + ic('more') + '<span>More</span></button>'
    + '</div></div>';

  let files;
  if (detail.fileChanges === null) {
    files = '<div class="gi-sec">Files</div><div class="gi-note">' + ic('spinner', 'spin ic-sm') + ' Loading files…</div>';
  } else if (detail.fileChanges.length === 0 && parentCount > 1) {
    files = '<div class="gi-sec">Files<span class="n">0</span></div>'
      + '<div class="gi-note">A merge lists no files of its own. Compare it with its first parent to see what it brought in.</div>'
      + '<div class="gi-note"><button type="button" class="linkbtn" data-act="compare-parent">' + ic('compare', 'ic-sm') + 'Compare with first parent</button></div>';
  } else {
    files = filesSectionHtml(detail);
  }

  // Every row is always here, in the same order, even when the committer
  // repeats the author: a field that comes and goes cannot be found by muscle
  // memory, and a rebase or an amend is exactly what makes the two dates differ.
  let meta = '<details class="gi-det"' + (panel._detailsOpen ? ' open' : '') + '><summary>' + ic('chev-r', 'ic-sm') + 'Details</summary><div class="detail-meta">';
  meta += metaRow('Commit', [hashCell(detail.hash)]);
  if (parentCount > 0) meta += metaRow(parentCount > 1 ? 'Parents' : 'Parent', detail.parents.map(hashCell));
  meta += metaRow('Author', [personCell(detail.author, detail.authorEmail)]);
  meta += metaRow('Author date', [whenCell(detail.authorDate)]);
  meta += metaRow('Committer', [personCell(detail.committer, detail.committerEmail)]);
  meta += metaRow('Commit date', [whenCell(detail.commitDate)]);
  meta += '</div></details>';

  panel.dataset.view = 'commit';
  panel.dataset.hash = detail.hash;
  panel.innerHTML = head + messageBodyHtml(detail.message) + files + meta;
  panel.scrollTop = keepScroll;
  requestFileIcons();
}

// --- A stash ---
function renderStashPanel(detail) {
  const panel = document.getElementById('detail-panel');
  const stash = stashByHash(detail.hash);
  const ref = stash ? 'stash@{' + stash.index + '}' : 'stash';
  const parts = stashParts(stash ? stash.message : detail.message);
  const base = detail.parents[0] || (stash ? stash.parentHash : '');
  const when = detail.authorDate ? longAgo(detail.authorDate) : '';

  let html = '<div class="grab"></div><div class="gi-head"><div class="gi-top">'
    + '<span class="avatar lg stash-badge" aria-hidden="true">' + ic('stash', 'ic-sm') + '</span>'
    + '<div class="gi-who"><b>' + escHtml(ref) + '</b><small>' + escHtml(when)
    + (parts.branch ? (when ? ' · ' : '') + 'on ' + escHtml(parts.branch) : '') + '</small></div>'
    + '<span class="grow"></span>' + moreButton('stash-more') + CLOSE_BUTTON + '</div>'
    + '<h3 class="gi-subj">' + escHtml(parts.message || '(no message)') + '</h3>'
    + (base ? '<div class="gi-meta"><span>based on</span><button type="button" class="hash" data-act="select" data-hash="' + escHtml(base) + '" title="Show the commit it was made on">' + escHtml(String(base).slice(0, 7)) + '</button></div>' : '')
    + '<div class="gi-acts">'
    + '<button type="button" class="btn outline" data-act="stash-apply">' + ic('check') + '<span>Apply</span></button>'
    + '<button type="button" class="btn outline" data-act="stash-pop">' + ic('arrow-up') + '<span>Pop</span></button>'
    + '<button type="button" class="btn outline" data-act="stash-branch">' + ic('fork') + '<span>Branch…</span></button>'
    + '<button type="button" class="btn outline more-act" data-act="stash-more">' + ic('more') + '<span>More</span></button>'
    + '</div></div>';
  const files = detail.fileChanges === null
    ? '<div class="gi-sec">Files</div><div class="gi-note">' + ic('spinner', 'spin ic-sm') + ' Loading files…</div>'
    : filesSectionHtml(detail);
  panel.dataset.view = 'stash';
  panel.dataset.hash = detail.hash;
  panel.innerHTML = html + files;
  requestFileIcons();
}

// --- Uncommitted changes ---
/*
 * Built once and then updated in parts: the changes are read again every five
 * seconds, and rebuilding the panel would take the cursor out of the message
 * box someone is typing in.
 */
function renderWipPanel() {
  const panel = document.getElementById('detail-panel');
  if (panel.dataset.view !== 'wip') {
    panel.dataset.view = 'wip';
    panel.dataset.hash = 'uncommitted';
    wipFilesSig = '';
    panel.innerHTML = '<div class="grab"></div><div class="gi-head"><div class="gi-top">'
      + '<span class="avatar lg wip-badge" aria-hidden="true">' + ic('edit', 'ic-sm') + '</span>'
      + '<div class="gi-who"><b>Uncommitted changes</b><small id="wip-who"></small></div>'
      + '<span class="grow"></span>'
      + '<button type="button" class="tool" data-act="wip-more" title="More actions" aria-label="More actions">' + ic('more') + '</button>'
      + CLOSE_BUTTON + '</div>'
      + '<div class="progress" id="wip-progress"></div></div>'
      + '<div class="cmp"><textarea id="commit-message" rows="2" aria-label="Commit message"></textarea>'
      + '<div class="row"><div class="split">'
      + '<button type="button" class="btn primary" id="btn-commit" data-act="commit">' + ic('check') + '<span>Commit</span></button>'
      + '<button type="button" class="btn primary" id="btn-commit-menu" data-act="commit-menu" aria-label="More commit actions" title="More commit actions" aria-haspopup="menu">' + ic('chev-d') + '</button>'
      + '</div></div><div class="hint" id="commit-hint"></div></div>'
      + '<div class="sc-lh"><span class="lbl">Changes</span><span class="n" id="wip-count">0</span><span class="grow"></span>'
      + '<button type="button" class="linkbtn" data-act="review" title="Review block by block">' + ic('file-diff', 'ic-sm') + 'Review</button>'
      + '<button type="button" class="cb-cell" id="wip-toggle-all" data-act="toggle-all"></button></div>'
      + '<div id="wip-list"></div>';
    const ta = document.getElementById('commit-message');
    ta.value = state.draft.message || '';
    ta.addEventListener('input', () => {
      state.draftEditedAt = Date.now();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => vscode.postMessage({ command: 'saveDraft', message: ta.value }), 400);
      updateCommitControls();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitStaged({}); }
    });
  }
  updateWipPanel();
}

function updateWipPanel() {
  const panel = document.getElementById('detail-panel');
  if (panel.dataset.view !== 'wip') return;
  const files = changedFiles();
  const t = changeTotals(files);
  const branch = (state.changes && state.changes.branch && state.changes.branch.head) || state.currentBranch || '';
  document.getElementById('wip-who').textContent = (branch ? 'on ' + branch + ' · ' : '') + plural(t.files, 'file');
  document.getElementById('wip-progress').innerHTML = t.files
    ? segsHtml(t) + '<span><b>' + t.blocksStaged + ' of ' + t.blocks + '</b> blocks staged</span><span class="grow"></span>'
      + '<button type="button" class="linkbtn" data-act="review">' + ic('file-diff', 'ic-sm') + 'Review changes</button>'
    : '<span>The working tree matches the last commit.</span>';
  document.getElementById('wip-count').textContent = String(files.length);
  const all = allCheckState(files);
  const toggle = document.getElementById('wip-toggle-all');
  toggle.innerHTML = checkboxHtml(all);
  toggle.title = all === 'all' ? 'Unstage everything' : 'Stage everything';
  toggle.setAttribute('aria-label', toggle.title);
  toggle.disabled = !files.some((f) => !f.conflict);

  const sig = JSON.stringify(files);
  if (sig !== wipFilesSig) {
    wipFilesSig = sig;
    const conflicts = files.filter((f) => f.conflict);
    const rest = files.filter((f) => !f.conflict);
    document.getElementById('wip-list').innerHTML =
      (conflicts.length ? '<div class="sc-group err">' + ic('alert', 'ic-sm') + 'Conflicts<span class="n">' + conflicts.length + '</span></div>' + conflicts.map(wipFileRowHtml).join('') : '')
      + rest.map(wipFileRowHtml).join('');
    requestFileIcons();
  }
  applyDraft();
  updateCommitControls();
}

function checkboxHtml(check) {
  return '<span class="cb' + (check === 'all' ? ' on' : check === 'some' ? ' some' : '') + '" aria-hidden="true">' + (check === 'all' ? ic('check') : '') + '</span>';
}

function dotsHtml(file) {
  const dots = blockDots(file);
  const staged = dots.filter(Boolean).length;
  let html = '';
  dots.slice(0, 6).forEach((on) => { html += '<i class="dot' + (on ? ' on' : '') + '"></i>'; });
  if (dots.length > 6) html += '<span class="more">+' + (dots.length - 6) + '</span>';
  return '<span class="dots" title="' + escHtml(staged + ' of ' + plural(dots.length, 'block') + ' staged') + '">' + html + '</span>';
}

/** One changed file, as Source Control draws it. */
function wipFileRowHtml(file) {
  const path = escHtml(file.path);
  const letter = changeLetter(file);
  const check = fileCheckState(file);
  const name = escHtml(splitPath(file.path)[1]);
  const counts = changeCounts(file);
  const note = lineNote(file);
  const right = file.conflict
    ? '<span class="resolve">Resolve</span>'
    : dotsHtml(file) + (note ? '<span class="note">' + escHtml(note) + '</span>' : countsHtml(counts.added, counts.removed));
  const discardable = hasUnstaged(file);
  return '<div class="sc-row' + (letter === 'D' ? ' del' : '') + '" data-path="' + path + '">'
    + '<button type="button" class="main" data-act="' + (file.conflict ? 'wip-resolve' : 'wip-review') + '" data-path="' + path + '" title="'
    + (file.conflict ? 'Resolve the conflict in ' : 'Review ') + path + '">'
    + fileIconHtml(file.path) + nameAndDir(file.path) + '<span class="rt">' + right + '</span>' + statusTile(letter) + '</button>'
    + '<span class="acts">'
    + '<button type="button" data-act="wip-file-open" data-path="' + path + '" title="Open file" aria-label="Open file">' + ic('doc', 'ic-sm') + '</button>'
    + '<button type="button" class="danger" data-act="wip-discard" data-path="' + path + '" title="'
    + (discardable ? 'Discard changes…' : 'Only staged changes left') + '" aria-label="Discard changes"' + (discardable ? '' : ' disabled') + '>' + ic('trash', 'ic-sm') + '</button>'
    + '</span>'
    + '<button type="button" class="cb-cell" data-act="wip-toggle" data-path="' + path + '" role="checkbox" aria-checked="'
    + (check === 'all' ? 'true' : check === 'some' ? 'mixed' : 'false') + '" aria-label="' + (check === 'all' ? 'Unstage ' : 'Stage ') + name
    + '" title="' + (file.conflict ? 'Mark resolved' : check === 'all' ? 'Unstage file' : 'Stage file') + '">' + checkboxHtml(check) + '</button>'
    + '</div>';
}

function fileByPath(path) {
  return changedFiles().find((f) => f.path === path) || null;
}

/* The draft is shared with Source Control and the Review tab. What arrives
   from them replaces the box, except while it is being typed in here: a poll
   landing between two keystrokes would otherwise put back the older text. */
function applyDraft() {
  const ta = document.getElementById('commit-message');
  if (!ta) return;
  const branch = (state.changes && state.changes.branch && state.changes.branch.head) || '';
  ta.placeholder = branch ? 'Message (' + COMMIT_KEYS + ' to commit on ' + branch + ')' : 'Message (' + COMMIT_KEYS + ' to commit)';
  if (Date.now() - state.draftEditedAt < 3000) return;
  const message = state.draft.message || '';
  if (ta.value !== message) ta.value = message;
}

function updateCommitControls() {
  const ta = document.getElementById('commit-message');
  const btn = document.getElementById('btn-commit');
  if (!ta || !btn) return;
  const t = changeTotals(changedFiles());
  const busy = !!state.busy.commit;
  btn.disabled = busy || anyBusy() || !canCommit(t, ta.value);
  btn.innerHTML = (busy ? ic('spinner', 'spin') : ic('check')) + '<span>' + escHtml(commitLabel(t)) + '</span>';
  document.getElementById('btn-commit-menu').disabled = anyBusy();
  document.getElementById('commit-hint').textContent = commitHint(t, ta.value, COMMIT_KEYS);
}

// --- The inspector's one click delegate ---
{
  const panel = document.getElementById('detail-panel');
  panel.addEventListener('click', (e) => {
    // The header's dismiss.
    if (e.target.closest('.detail-close')) { e.stopPropagation(); closeDetailPanel(); return; }
    // Metadata values. The clipboard write is silent, so the thing clicked says
    // it happened — after the answer, rather than assuming one.
    const copySource = e.target.closest('[data-copy]');
    if (copySource) {
      e.stopPropagation();
      copyText(copySource.dataset.copy).then((ok) => {
        const cls = ok ? 'copied' : 'copy-failed';
        copySource.classList.add(cls);
        setTimeout(() => copySource.classList.remove(cls), 900);
      });
      return;
    }
    // A hash mentioned in a message is a way to that commit, when it is loaded.
    const mention = e.target.closest('span.commit-link[title]');
    if (mention && /^[0-9a-f]{7,40}$/i.test(mention.title)) {
      const hit = getDisplayCommits().find((c) => c.hash.startsWith(mention.title.toLowerCase()));
      if (hit) { selectCommit(hit.hash, { scroll: true }); return; }
    }
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    // The header is drawn from the row before git's answer arrives, so its
    // buttons act on the selection rather than waiting for the full detail.
    const hash = state.selectedCommit;
    switch (act) {
      case 'select': selectCommit(el.dataset.hash, { scroll: true }); break;
      case 'file-open': e.stopPropagation(); openFile(el.closest('.gi-file').dataset.path); break;
      case 'file': vscode.postMessage({ command: 'openDiff', filePath: el.dataset.path, hash: el.dataset.hash, parentHash: el.dataset.parent || null }); break;
      case 'checkout': checkoutCommit(hash, el); break;
      case 'branch': createBranchAt(hash); break;
      case 'cherry-pick': cherryPick(hash); break;
      case 'commit-more': { const c = selectedCommitObject(); if (c) openMenu(commitMenuItems(c, false), el); break; }
      case 'compare-parent': { const c = selectedCommitObject(); if (c && c.parents[0]) vscode.postMessage({ command: 'openCompare', ref1: c.parents[0], ref2: c.hash }); break; }
      case 'stash-apply': stashActionFor(state.selectedCommit, 'apply'); break;
      case 'stash-pop': stashActionFor(state.selectedCommit, 'pop'); break;
      case 'stash-branch': stashBranchFor(state.selectedCommit); break;
      case 'stash-more': openMenu(stashMenuItems(state.selectedCommit), el); break;
      case 'review': openReview(); break;
      case 'wip-more': openMenu(wipMenuItems(), el); break;
      case 'commit': commitStaged({}); break;
      case 'commit-menu': openMenu(commitSplitItems(), el); break;
      case 'toggle-all': toggleAllFiles(); break;
      case 'wip-review': openReview(el.dataset.path); break;
      case 'wip-resolve': vscode.postMessage({ command: 'openConflictFile', filePath: el.dataset.path }); break;
      case 'wip-file-open': openFile(el.dataset.path); break;
      case 'wip-discard': { const f = fileByPath(el.dataset.path); if (f) askDiscard([f]); break; }
      case 'wip-toggle': { const f = fileByPath(el.dataset.path); if (f) toggleFile(f); break; }
    }
  });
  panel.addEventListener('toggle', (e) => {
    if (e.target.classList && e.target.classList.contains('gi-det')) panel._detailsOpen = e.target.open;
  }, true);
  panel.addEventListener('contextmenu', (e) => {
    const target = inspectorMenuTarget(e.target);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    target({ x: e.clientX, y: e.clientY });
  });
  setupLongPress(panel, (x, y, el) => {
    const target = inspectorMenuTarget(el);
    if (target) target({ x, y });
  });
  panel.addEventListener('dblclick', (e) => {
    const pill = e.target.closest('.ref[data-ref]');
    if (pill && pill.dataset.refType !== 'stash') checkoutRef(pill.dataset.ref, pill.dataset.refType);
  });
}

/** What a right-click or a long press inside the inspector opens, if anything. */
function inspectorMenuTarget(el) {
  if (!el || !el.closest) return null;
  const pill = el.closest('.ref[data-ref]');
  if (pill) {
    const commit = selectedCommitObject();
    return (anchor) => {
      if (pill.dataset.refType === 'stash') openMenu(stashMenuItems(state.selectedCommit), anchor);
      else showRefMenu(pill.dataset.ref, pill.dataset.refType, commit, anchor);
    };
  }
  const file = el.closest('.gi-file');
  if (file) return (anchor) => openMenu(commitFileMenuItems(file.dataset.path, file.dataset.hash, file.dataset.parent), anchor);
  const row = el.closest('.sc-row');
  if (row) {
    const f = fileByPath(row.dataset.path);
    if (f) return (anchor) => openMenu(wipFileMenuItems(f), anchor);
  }
  return null;
}

function selectedCommitObject() {
  const hash = state.selectedCommit;
  if (!hash || hash === 'uncommitted') return null;
  return findCommit(hash) || (state.detail && state.detail.hash === hash ? { ...state.detail, refs: [] } : null);
}

{
  document.getElementById('sheet-scrim').addEventListener('click', closeDetailPanel);
}
`;
}
