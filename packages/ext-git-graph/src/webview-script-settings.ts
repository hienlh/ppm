/**
 * The Git Graph script's settings panel: display options, the column choice,
 * git's user details, remotes, issue links and pull-request links.
 *
 * Part of one shared script; see webview-script-core.ts for the rules.
 */
export function settingsScript(): string {
  return String.raw`
// --- Settings ---
function openSettings() {
  document.getElementById('settings-panel').classList.add('open');
  vscode.postMessage({ command: 'requestSettings' });
  vscode.postMessage({ command: 'requestUserDetails' });
  renderRemotesList();
}

function closeSettings() {
  document.getElementById('settings-panel').classList.remove('open');
}

function settingsOpen() {
  return document.getElementById('settings-panel').classList.contains('open');
}

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
  document.getElementById('s-autoFetchInterval').value = String(s.autoFetchInterval || 0);
  OPTIONAL_COLUMNS.forEach((col) => {
    document.getElementById('s-' + col.key).checked = s[col.key] !== false;
  });
  const root = document.documentElement.classList;
  root.toggle('date-abs', s.dateFormat === 'absolute');
  root.toggle('date-iso', s.dateFormat === 'iso');
  graphConfig.style = s.graphStyle;
  applyColumnVisibility();
  startAutoFetch(s.autoFetchInterval);
  renderIssueRules();
  applyPrSettingsToUI();
}

{
  document.getElementById('settings-close').addEventListener('click', closeSettings);

  // The same toggles as the View menu and the header's context menu, through the same call.
  OPTIONAL_COLUMNS.forEach((col) => {
    document.getElementById('s-' + col.key).addEventListener('change', (e) => setColumnVisible(col.key, e.target.checked));
  });

  ['showTags', 'showStashes', 'showRemoteBranches'].forEach((key) => {
    document.getElementById('s-' + key).addEventListener('change', (e) => {
      state.settings[key] = e.target.checked;
      vscode.postMessage({ command: 'updateSetting', key, value: e.target.checked });
      renderCommitList();
    });
  });
  // These change which commits git lists, so the history is read again.
  ['firstParentOnly', 'commitOrdering'].forEach((key) => {
    document.getElementById('s-' + key).addEventListener('change', (e) => {
      const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      state.settings[key] = value;
      vscode.postMessage({ command: 'updateSetting', key, value });
      vscode.postMessage({ command: 'requestCommits', branch: state.scope === 'all' ? undefined : state.scope, maxCommits: refreshCount() });
    });
  });
  document.getElementById('s-graphStyle').addEventListener('change', (e) => {
    state.settings.graphStyle = e.target.value;
    graphConfig.style = e.target.value;
    vscode.postMessage({ command: 'updateSetting', key: 'graphStyle', value: e.target.value });
    graphRender();
  });
  document.getElementById('s-dateFormat').addEventListener('change', (e) => {
    state.settings.dateFormat = e.target.value;
    vscode.postMessage({ command: 'updateSetting', key: 'dateFormat', value: e.target.value });
    const root = document.documentElement.classList;
    root.toggle('date-abs', e.target.value === 'absolute');
    root.toggle('date-iso', e.target.value === 'iso');
    renderCommitList();
  });
  document.getElementById('s-maxCommits').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10);
    if (!(n > 0 && n <= 10000)) { e.target.value = state.settings.maxCommits; return; }
    state.maxCommits = n;
    state.settings.maxCommits = n;
    vscode.postMessage({ command: 'updateSetting', key: 'maxCommits', value: n });
  });
  document.getElementById('s-autoFetchInterval').addEventListener('change', (e) => {
    const n = parseInt(e.target.value, 10) || 0;
    state.settings.autoFetchInterval = n;
    vscode.postMessage({ command: 'updateSetting', key: 'autoFetchInterval', value: n });
    startAutoFetch(n);
  });

  document.getElementById('s-saveUser').addEventListener('click', () => {
    const name = document.getElementById('s-userName').value.trim();
    const email = document.getElementById('s-userEmail').value.trim();
    vscode.postMessage({ command: 'updateUserDetails', name, email });
    showToast('Saved the name and email for this repository', { kind: 'success' });
  });
}

// --- Remotes ---
function renderRemotesList() {
  const container = document.getElementById('s-remotes-list');
  if (!state.remotes.length) {
    container.innerHTML = '<p class="settings-note">No remotes yet.</p>';
    return;
  }
  container.innerHTML = state.remotes.map((r) => '<div class="remote-item">'
    + '<div class="remote-name">' + escHtml(r.name) + '</div>'
    + '<div class="remote-url">' + escHtml(r.fetchUrl) + '</div>'
    + '<div class="remote-actions">'
    + '<button type="button" class="btn xs outline" data-edit-remote="' + escHtml(r.name) + '">' + ic('edit', 'ic-sm') + 'Edit URL</button>'
    + '<button type="button" class="btn xs outline" data-rm-remote="' + escHtml(r.name) + '">' + ic('trash', 'ic-sm') + 'Remove</button>'
    + '</div></div>').join('');
}

{
  document.getElementById('s-remotes-list').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-remote]');
    if (edit) {
      const name = edit.dataset.editRemote;
      const remote = state.remotes.find((r) => r.name === name);
      showDialog({
        title: 'Edit the URL of ' + name,
        input: { placeholder: 'URL', defaultValue: remote ? remote.fetchUrl : '' },
        confirmLabel: 'Save',
        onConfirm: (url) => { if (url && url.trim()) vscode.postMessage({ command: 'editRemoteUrl', name, url: url.trim() }); },
      });
      return;
    }
    const rm = e.target.closest('[data-rm-remote]');
    if (rm) {
      const name = rm.dataset.rmRemote;
      showDialog({
        title: 'Remove the remote ' + name + '?',
        message: 'Its remote branches go from this repository. Nothing on the server is touched, and the remote can be added again.',
        destructive: true,
        confirmLabel: 'Remove remote',
        onConfirm: () => vscode.postMessage({ command: 'removeRemote', name }),
      });
    }
  });

  document.getElementById('s-addRemote').addEventListener('click', () => {
    const nameEl = document.getElementById('s-newRemoteName');
    const urlEl = document.getElementById('s-newRemoteUrl');
    const name = nameEl.value.trim();
    const url = urlEl.value.trim();
    if (!name) { nameEl.focus(); return; }
    if (!url) { urlEl.focus(); return; }
    vscode.postMessage({ command: 'addRemote', name, url });
    nameEl.value = '';
    urlEl.value = '';
  });
}

// --- Issue links ---
function renderIssueRules() {
  const rules = state.settings.issueLinkingRules || [];
  document.getElementById('issue-rules-list').innerHTML = rules.map((r, i) => '<div class="issue-rule-row" data-idx="' + i + '">'
    + '<input type="text" class="rule-pattern" aria-label="Pattern" placeholder="Regex, e.g. #(\\d+)" value="' + escHtml(r.pattern) + '">'
    + '<input type="text" class="rule-url" aria-label="Link" placeholder="URL with $1" value="' + escHtml(r.url) + '">'
    + '<button type="button" class="tool rule-remove" title="Remove rule" aria-label="Remove rule">' + ic('x', 'ic-sm') + '</button>'
    + '</div>').join('');
}

{
  let issueRuleTimer = null;
  const list = document.getElementById('issue-rules-list');
  list.addEventListener('input', (e) => {
    const row = e.target.closest('.issue-rule-row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    const rules = (state.settings.issueLinkingRules || []).slice();
    if (!rules[idx]) return;
    if (e.target.classList.contains('rule-pattern')) {
      try { new RegExp(e.target.value); e.target.classList.remove('rule-error'); }
      catch (err) { e.target.classList.add('rule-error'); return; }
      rules[idx] = { ...rules[idx], pattern: e.target.value };
    }
    if (e.target.classList.contains('rule-url')) rules[idx] = { ...rules[idx], url: e.target.value };
    state.settings.issueLinkingRules = rules;
    clearTimeout(issueRuleTimer);
    issueRuleTimer = setTimeout(() => vscode.postMessage({ command: 'updateSetting', key: 'issueLinkingRules', value: rules }), 500);
  });
  list.addEventListener('click', (e) => {
    if (!e.target.closest('.rule-remove')) return;
    const idx = parseInt(e.target.closest('.issue-rule-row').dataset.idx, 10);
    const rules = (state.settings.issueLinkingRules || []).slice();
    rules.splice(idx, 1);
    state.settings.issueLinkingRules = rules;
    vscode.postMessage({ command: 'updateSetting', key: 'issueLinkingRules', value: rules });
    renderIssueRules();
  });
  document.getElementById('add-issue-rule').addEventListener('click', () => {
    const rules = (state.settings.issueLinkingRules || []).concat([{ pattern: '', url: '' }]);
    state.settings.issueLinkingRules = rules;
    vscode.postMessage({ command: 'updateSetting', key: 'issueLinkingRules', value: rules });
    renderIssueRules();
  });
}

// --- Pull-request links ---
/* The placeholders are written as '$' + '{name}' so that the two characters
   never meet in this file: here they would end the template literal the whole
   script is written in. */
function prPlaceholder(name) { return '$' + '{' + name + '}'; }

function prTemplate(provider) {
  const o = prPlaceholder('owner'), r = prPlaceholder('repo');
  const src = prPlaceholder('sourceBranch'), dst = prPlaceholder('targetBranch');
  switch (provider) {
    case 'github': return 'https://github.com/' + o + '/' + r + '/compare/' + dst + '...' + src + '?expand=1';
    case 'gitlab': return 'https://gitlab.com/' + o + '/' + r + '/-/merge_requests/new?source_branch=' + src + '&target_branch=' + dst;
    case 'bitbucket': return 'https://bitbucket.org/' + o + '/' + r + '/pull-requests/new?source=' + src + '&dest=' + dst;
  }
  return '';
}

function applyPrSettingsToUI() {
  const pr = state.settings.prCreation;
  const config = document.getElementById('pr-config');
  if (!pr) {
    document.getElementById('pr-provider').value = '';
    config.classList.add('hidden');
    return;
  }
  document.getElementById('pr-provider').value = pr.provider;
  config.classList.remove('hidden');
  document.getElementById('pr-owner').value = pr.owner || '';
  document.getElementById('pr-repo').value = pr.repo || '';
  document.getElementById('pr-target').value = pr.defaultTargetBranch || 'main';
  document.getElementById('pr-url-template').value = pr.urlTemplate || '';
}

function openPrUrl(sourceBranch) {
  const pr = state.settings.prCreation;
  if (!pr || !pr.urlTemplate) return;
  const fill = { owner: pr.owner || '', repo: pr.repo || '', sourceBranch, targetBranch: pr.defaultTargetBranch || 'main' };
  let url = pr.urlTemplate;
  Object.keys(fill).forEach((key) => { url = url.split(prPlaceholder(key)).join(encodeURIComponent(fill[key])); });
  openExternal(url);
}

{
  document.getElementById('pr-vars').textContent = 'Placeholders: ' + ['owner', 'repo', 'sourceBranch', 'targetBranch'].map(prPlaceholder).join(', ');
  document.getElementById('pr-provider').addEventListener('change', (e) => {
    const provider = e.target.value;
    const config = document.getElementById('pr-config');
    if (!provider) {
      config.classList.add('hidden');
      state.settings.prCreation = null;
      vscode.postMessage({ command: 'updateSetting', key: 'prCreation', value: null });
      return;
    }
    config.classList.remove('hidden');
    document.getElementById('pr-url-template').value = prTemplate(provider);
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
    showToast('Saved the pull-request link', { kind: 'success' });
  });
}
`;
}
