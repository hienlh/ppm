/**
 * The Git Graph script's first part: every constant and every piece of state,
 * then the small helpers the rest is written in — icons, escaping, dates,
 * avatars, the clipboard, long-press, menus, dialogs and toasts.
 *
 * The script is one classic `<script>` assembled from several template strings
 * (webview-html.ts), so the parts share one scope. Function declarations are
 * hoisted across all of them, but `const` and `let` are not, which is why every
 * one of them lives here, ahead of any code that runs.
 *
 * Written with `String.raw`: what is between the backticks is the JavaScript
 * exactly as shipped, backslashes included. Two things still end or split the
 * literal and must never appear inside it — a backtick, and a dollar sign
 * followed by an opening brace.
 */
import { AVATAR_JS } from "./webview-shell.ts";
import { COMMIT_MESSAGE_JS } from "./commit-message-html.ts";
import { WIP_MODEL_JS } from "./wip-model.ts";
import { WEBVIEW_ICONS } from "./webview-icons.generated.ts";

export function coreScript(messageMinW: number, graphMinW: number): string {
  return String.raw`
const vscode = acquireVsCodeApi();
const SVG_NS = 'http://www.w3.org/2000/svg';
const NULL_VERTEX_ID = -1;
const MESSAGE_MIN_W = ${messageMinW};
const GRAPH_MIN_W = ${graphMinW};
// The row's flex gap and its right padding, which the graph's cap has to leave
// room for — the same numbers as the stylesheet's .commit-row.
const ROW_GAP = 10;
const ROW_PAD = 12;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
// The same label Source Control's composer shows.
const COMMIT_KEYS = IS_MAC ? '⌘↵' : 'Ctrl+↵';
const COPY_KEYS = IS_MAC ? '⌘C' : 'Ctrl+C';
const graphConfig = {
  // Lanes 16px apart; the row height is measured, because it changes with the
  // pointer and the width (32px, 40px on touch, 56px on a phone).
  grid: { x: 16, y: 32, offsetX: 12, offsetY: 16 },
  style: 'rounded',
};

const DEFAULT_SETTINGS = {
  maxCommits: 300, showTags: true, showStashes: true, showRemoteBranches: true,
  graphStyle: 'rounded', firstParentOnly: false, dateFormat: 'relative', commitOrdering: 'topo',
  issueLinkingRules: [{ pattern: '#(\\d+)', url: '' }], prCreation: null,
  autoFetchInterval: 0,
  colChanges: true, colAuthor: true, colDate: true, colHash: true,
};

/** Optional columns, in the order the header declares them. */
const OPTIONAL_COLUMNS = [
  { key: 'colChanges', cls: 'cols-no-changes', label: 'Changes' },
  { key: 'colAuthor', cls: 'cols-no-author', label: 'Author' },
  { key: 'colDate', cls: 'cols-no-date', label: 'Date' },
  { key: 'colHash', cls: 'cols-no-hash', label: 'Hash' },
];

const ICONS = ${JSON.stringify(WEBVIEW_ICONS)};

// The app's project-avatar gradients, reused for authors.
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #667eea, #764ba2)', 'linear-gradient(135deg, #f5576c, #f093fb)',
  'linear-gradient(135deg, #4facfe, #00c6ff)', 'linear-gradient(135deg, #43e97b, #38f9d7)',
  'linear-gradient(135deg, #fa709a, #fee140)', 'linear-gradient(135deg, #a18cd1, #6a3de8)',
  'linear-gradient(135deg, #fd7043, #ff8a65)', 'linear-gradient(135deg, #26c6da, #0097a7)',
  'linear-gradient(135deg, #ab47bc, #7b1fa2)', 'linear-gradient(135deg, #ef5350, #b71c1c)',
  'linear-gradient(135deg, #1976d2, #42a5f5)', 'linear-gradient(135deg, #2e7d32, #66bb6a)',
];

const state = {
  repo: '',
  commits: [],
  branches: [],
  tags: [],
  remotes: [],
  stashes: [],
  currentBranch: '',
  head: '',
  /** Where a commit opens in a browser: base + commitPath + hash. */
  remoteWeb: null,
  /** 'all' or the one branch the list is scoped to. */
  scope: 'all',
  /** The row the inspector describes: a hash, 'uncommitted' or a stash's hash. */
  selectedCommit: null,
  inspectorOpen: false,
  /** The full detail of the selected commit or stash, once it has arrived. */
  detail: null,
  maxCommits: 300,
  loading: false,
  hasMore: false,
  commitsLoaded: false,
  /** PPM's GitChanges for the working tree, or null before the first read. */
  changes: null,
  changesError: null,
  changesLoaded: false,
  /** The commit the host was last asked to re-read the history for. */
  requestedOid: null,
  /** The shared commit message, and when it was last typed here. */
  draft: { message: '', updatedAt: null },
  draftEditedAt: 0,
  autoSelected: false,
  searchQuery: '',
  searchMatches: [],
  searchIndex: -1,
  /** hash -> {files, insertions, deletions}; arrives after the commits. */
  stats: {},
  settings: { ...DEFAULT_SETTINGS },
  userDetails: { name: '', email: '' },
  /** Dragged width of the graph column, or null while it sizes itself. */
  graphColWidth: null,
  /** Width the lanes actually need — what the column is capped against. */
  graphWidth: 0,
  /** How far the graph is panned inside its column. */
  graphPanX: 0,
  /** The row height the graph was last drawn for. */
  renderedRowH: 0,
  /** The ahead count the head pill was last drawn with. */
  renderedAhead: -1,
  worktrees: [],
  submodules: [],
  /** Actions in flight, by name: their buttons wait. */
  busy: {},
};

/** Callbacks waiting for an actionResult: by action name, then by the request's id. */
const pendingActions = {};
let lastRequestId = 0;
let menuState = null;
let draftTimer = null;
let autoFetchTimer = null;
let panHintTimer = null;
let dragRef = null;
let wipFilesSig = '';
let wipRowSig = '';
let gVertices = [], gBranches = [], gAvailColours = [], gCommitLookup = {}, gHeadColour = 0;

document.documentElement.classList.add('insp-closed');

// --- Icons ---
function ic(name, cls) {
  const svg = ICONS[name] || '';
  return cls ? svg.replace('class="ic"', 'class="ic ' + cls + '"') : svg;
}

// --- Text ---
function escHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
${AVATAR_JS}
${COMMIT_MESSAGE_JS}
${WIP_MODEL_JS}

/** Lines added and removed, the way Source Control prints them. */
function countsHtml(added, removed) {
  const a = Number(added) || 0;
  const d = Number(removed) || 0;
  return '<span class="cnt">' + (a || !d ? '<span class="a">+' + a + '</span>' : '')
    + (d ? '<span class="d">−' + d + '</span>' : '') + '</span>';
}

/** Initials on one of the project gradients, keyed by email so a person keeps one colour. */
function avatarFor(name, email, lg) {
  const key = String(email || name || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  const bg = AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
  return '<span class="avatar' + (lg ? ' lg' : '') + '" style="background:' + bg + '" aria-hidden="true">'
    + escHtml(authorInitials(name)) + '</span>';
}

/** Text with every occurrence of the query marked, escaped either way. */
function markText(text, q) {
  const s = String(text == null ? '' : text);
  if (!q) return escHtml(s);
  const lower = s.toLowerCase();
  let out = '';
  let from = 0;
  let at = lower.indexOf(q, from);
  while (at !== -1) {
    out += escHtml(s.slice(from, at)) + '<mark>' + escHtml(s.slice(at, at + q.length)) + '</mark>';
    from = at + q.length;
    at = lower.indexOf(q, from);
  }
  return out + escHtml(s.slice(from));
}

function firstLine(message) {
  const s = String(message || '');
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

// --- Dates ---
function formatDate(ts) {
  const fmt = state.settings.dateFormat;
  if (fmt === 'iso') return new Date(ts * 1000).toISOString().substring(0, 16).replace('T', ' ');
  if (fmt === 'absolute') return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd';
  if (diff < 31536000) return Math.floor(diff / 2592000) + 'mo';
  return Math.floor(diff / 31536000) + 'y';
}

/** "3 days ago" — the inspector's sentence-length form. */
function longAgo(ts) {
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return 'just now';
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, word] of units) {
    if (diff >= secs) return plural(Math.floor(diff / secs), word) + ' ago';
  }
  return 'just now';
}

function absDate(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, WHEN_FORMAT);
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

/* A panel is mounted sandbox="allow-scripts" with no allow-same-origin, so it
   runs at an OPAQUE ORIGIN — and the default Permissions Policy allowlist for
   clipboard-write is "self", which an opaque origin never matches. Measured in
   Chromium with the iframe focused and a real click: writeText rejects with
   NotAllowedError, while a textarea plus execCommand('copy') returns true and
   the text really does land on the system clipboard.

   The modern call is still tried first, for the day the policy changes. The
   textarea has to stay RENDERED — display:none or visibility:hidden give an
   empty selection and execCommand then copies nothing while still returning
   true — and setSelectionRange is what actually selects on iOS. */
async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* fall through */ }
  }
  const ta = document.createElement('textarea');
  ta.value = String(text == null ? '' : text);
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;opacity:0;';
  document.body.appendChild(ta);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand('copy');
  } catch (e) {
    return false;
  } finally {
    ta.remove();
    if (selection && previous) { selection.removeAllRanges(); selection.addRange(previous); }
  }
}

function copyWithToast(text, what) {
  copyText(text).then((ok) => showToast(ok ? 'Copied ' + what : 'Could not copy ' + what, { kind: ok ? 'info' : 'error' }));
}

/** A link out of the sandbox: the app opens it, the frame cannot. Web addresses only. */
function openExternal(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return;
  vscode.postMessage({ command: '__ppm.openExternal', url: String(url) });
}

// --- Layout ---
/*
 * Below this width the row carries the graph and the message only, with the
 * author, date and hash on a second line under the subject, and the inspector
 * and every menu become bottom sheets. The value matches the max-width:640px
 * block in the CSS — both have to agree.
 */
function isNarrowLayout() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
}

/** Wide enough for the inspector to be a column beside the list rather than over it. */
function isColumnLayout() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 901px)').matches;
}

// --- Long press ---
/* Touch has no right-click. The timer is disarmed on touchcancel as well as on
   a move or a lift: once the browser decides the finger is scrolling it sends
   touchcancel and nothing else, and a timer left armed would open a menu over
   a list that is already moving. */
function setupLongPress(el, callback) {
  let timer = null;
  let startX = 0, startY = 0;
  el.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    timer = setTimeout(() => { timer = null; e.preventDefault(); callback(startX, startY, e.target); }, 500);
  }, { passive: false });
  el.addEventListener('touchmove', (e) => {
    if (timer && (Math.abs(e.touches[0].clientX - startX) > 10 || Math.abs(e.touches[0].clientY - startY) > 10)) {
      clearTimeout(timer); timer = null;
    }
  }, { passive: true });
  el.addEventListener('touchend', () => { if (timer) { clearTimeout(timer); timer = null; } });
  el.addEventListener('touchcancel', () => { if (timer) { clearTimeout(timer); timer = null; } });
}

// --- Menus ---
/*
 * One renderer for every menu in the panel: the toolbar's, the rows' context
 * menus and the inspector's. An item is
 *   { label, icon, kb, sub, checked, disabled, destructive, row2, action, children }
 * or { separator: true } / { heading: 'Label' } / { empty: 'text' }.
 * Anchored under an element (right-aligned when it sits in the right half) or
 * at a point; flipped above when there is no room below. On a phone it is a
 * bottom sheet over a scrim.
 */
function openMenu(items, anchor, opts) {
  opts = opts || {};
  const trigger = anchor && anchor.nodeType === 1 ? anchor : null;
  if (menuState && trigger && menuState.trigger === trigger) { closeMenu(); return; }
  closeMenu();
  const menu = document.getElementById('context-menu');
  menuState = { items, trigger, anchor, opts, filter: '' };
  menu.className = 'menu scroll-thin' + (isNarrowLayout() ? ' as-sheet' : '');
  menu.innerHTML = '<div class="grab"></div>'
    + (opts.filter ? '<label class="menu-filter">' + ic('search', 'ic-sm') + '<input type="text" placeholder="' + escHtml(opts.filter) + '" aria-label="' + escHtml(opts.filter) + '"></label>' : '')
    + '<div class="menu-items" role="none"></div>';
  renderMenuItems();
  menu.classList.remove('hidden');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  document.getElementById('menu-scrim').classList.toggle('hidden', !isNarrowLayout());
  placeMenu();
  const filter = menu.querySelector('.menu-filter input');
  if (filter) {
    filter.addEventListener('input', () => { menuState.filter = filter.value.trim().toLowerCase(); renderMenuItems(); });
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(0); }
      if (e.key === 'Enter') { e.preventDefault(); const first = menu.querySelector('.mi:not(:disabled)'); if (first) first.click(); }
    });
    if (!isNarrowLayout()) filter.focus();
  } else if (!isNarrowLayout()) {
    menu.setAttribute('tabindex', '-1');
    menu.focus({ preventScroll: true });
  }
}

function renderMenuItems() {
  const menu = document.getElementById('context-menu');
  const host = menu.querySelector('.menu-items');
  if (!host || !menuState) return;
  const q = menuState.filter;
  const items = q ? menuState.items.filter((it) => it.label && !it.separator && !it.heading
    && (String(it.label) + ' ' + String(it.sub || '')).toLowerCase().includes(q)) : menuState.items;
  const lead = items.some((it) => it.icon || it.checked !== undefined);
  let html = '';
  items.forEach((it) => {
    const idx = menuState.items.indexOf(it);
    if (it.separator) { html += '<div class="sep" role="separator"></div>'; return; }
    if (it.heading) { html += '<div class="lbl">' + escHtml(it.heading) + '</div>'; return; }
    if (it.empty) { html += '<div class="empty">' + escHtml(it.empty) + '</div>'; return; }
    const mark = it.checked !== undefined
      ? (it.checked ? ic('check', 'tick') : '<span class="blank"></span>')
      : it.icon ? ic(it.icon) : lead ? '<span class="blank"></span>' : '';
    const text = it.row2
      ? '<span class="row2"><span>' + escHtml(it.label) + '</span><small>' + escHtml(it.row2) + '</small></span>'
      : '<span>' + escHtml(it.label) + '</span>';
    const tail = it.kb ? '<span class="kb">' + escHtml(it.kb) + '</span>'
      : it.children ? '<span class="sub">' + ic('chev-r', 'ic-sm') + '</span>'
      : it.sub ? '<span class="sub">' + escHtml(it.sub) + '</span>' : '';
    html += '<button type="button" class="mi' + (it.destructive ? ' danger' : '') + '" role="'
      + (it.checked !== undefined ? 'menuitemcheckbox" aria-checked="' + !!it.checked : 'menuitem')
      + '" data-idx="' + idx + '"' + (it.disabled ? ' disabled' : '')
      + (it.title ? ' title="' + escHtml(it.title) + '"' : '') + '>' + mark + text + tail + '</button>';
  });
  if (q && !items.length) html = '<div class="empty">Nothing matches</div>';
  host.innerHTML = html;
}

function placeMenu() {
  const menu = document.getElementById('context-menu');
  if (!menuState || menu.classList.contains('as-sheet')) { menu.style.left = ''; menu.style.top = ''; return; }
  menu.style.left = '0px';
  menu.style.top = '0px';
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left, top;
  const anchor = menuState.anchor;
  if (anchor && anchor.nodeType === 1) {
    const r = anchor.getBoundingClientRect();
    left = r.left + r.width / 2 > vw / 2 ? r.right - w : r.left;
    top = r.bottom + 4;
    if (top + h > vh - 8 && r.top - h - 4 >= 8) top = r.top - h - 4;
  } else {
    const x = anchor ? anchor.x : 8;
    const y = anchor ? anchor.y : 8;
    left = x + w > vw - 8 ? x - w : x;
    top = y + h > vh - 8 ? y - h : y;
  }
  menu.style.left = Math.max(8, Math.min(left, vw - w - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(top, vh - h - 8)) + 'px';
}

function focusMenuItem(step) {
  const menu = document.getElementById('context-menu');
  const items = Array.from(menu.querySelectorAll('.mi:not(:disabled)'));
  if (!items.length) return;
  const at = items.indexOf(document.activeElement);
  const next = step === 0 ? 0 : at === -1 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next].focus();
}

function closeMenu() {
  if (!menuState) return;
  const menu = document.getElementById('context-menu');
  menu.classList.add('hidden');
  menu.innerHTML = '';
  document.getElementById('menu-scrim').classList.add('hidden');
  if (menuState.trigger) menuState.trigger.setAttribute('aria-expanded', 'false');
  const onClose = menuState.opts.onClose;
  menuState = null;
  if (onClose) onClose();
}

function menuIsOpen() { return !!menuState; }

{
  const menu = document.getElementById('context-menu');
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('.mi');
    if (!btn || btn.disabled || !menuState) return;
    const item = menuState.items[Number(btn.dataset.idx)];
    if (!item) return;
    if (item.children) {
      const anchor = menuState.anchor;
      const trigger = menuState.trigger;
      closeMenu();
      openMenu(item.children, trigger || anchor);
      return;
    }
    closeMenu();
    if (item.action) item.action();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(-1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const t = menuState && menuState.trigger; closeMenu(); if (t) t.focus(); }
  });
  document.getElementById('menu-scrim').addEventListener('click', closeMenu);
  // Outside a press closes it — on the way down, before the press lands on a
  // row and opens something else under the menu that was just dismissed.
  document.addEventListener('pointerdown', (e) => {
    if (!menuState) return;
    if (menu.contains(e.target)) return;
    if (menuState.trigger && menuState.trigger.contains(e.target)) return;
    closeMenu();
  }, true);
  window.addEventListener('resize', () => { if (menuState) placeMenu(); });
}

// --- Dialogs ---
/*
 * A confirmation or a one-field question, as a dialog on a wide panel and a
 * bottom sheet on a phone. The frame is sandboxed, so prompt and confirm do not
 * exist here: every answer is collected by markup the panel draws itself.
 *   { title, message, destructive, confirmLabel, cancelLabel,
 *     input: { placeholder, defaultValue }, select: { options, defaultValue, label },
 *     checkbox: { label, checked }, onConfirm(value, checked) }
 */
function showDialog(opts) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  let html = '<div class="grab"></div><h3>' + (opts.destructive ? ic('warn') : '') + '<span>' + escHtml(opts.title || 'Confirm') + '</span></h3>';
  if (opts.message) html += '<p>' + escHtml(opts.message) + '</p>';
  if (opts.select && opts.select.label) html += '<p>' + escHtml(opts.select.label) + '</p>';
  dialog.innerHTML = html;

  let inputEl = null;
  if (opts.input) {
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = opts.input.placeholder || '';
    inputEl.setAttribute('aria-label', opts.input.placeholder || opts.title || 'Value');
    if (opts.input.defaultValue) inputEl.value = opts.input.defaultValue;
    dialog.appendChild(inputEl);
  }
  if (opts.select) {
    inputEl = document.createElement('select');
    opts.select.options.forEach((o) => {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      if (o === opts.select.defaultValue) opt.selected = true;
      inputEl.appendChild(opt);
    });
    dialog.appendChild(inputEl);
  }
  let checkEl = null;
  if (opts.checkbox) {
    const label = document.createElement('label');
    label.className = 'check';
    checkEl = document.createElement('input');
    checkEl.type = 'checkbox';
    checkEl.checked = !!opts.checkbox.checked;
    label.appendChild(checkEl);
    label.appendChild(document.createTextNode(opts.checkbox.label));
    dialog.appendChild(label);
  }

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = opts.cancelLabel || 'Cancel';
  cancelBtn.className = 'btn outline';
  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = opts.confirmLabel || 'OK';
  confirmBtn.className = 'btn ' + (opts.destructive ? 'danger' : 'primary');
  const close = () => { overlay.remove(); if (opts.onCancel && !overlay._confirmed) opts.onCancel(); };
  cancelBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', () => {
    overlay._confirmed = true;
    overlay.remove();
    if (opts.onConfirm) opts.onConfirm(inputEl ? inputEl.value : undefined, checkEl ? checkEl.checked : undefined);
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    // Enter confirms from a field, never from a focused button — a button
    // answers Enter with its own click, and on Cancel that would confirm.
    if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); confirmBtn.click(); }
  });
  setTimeout(() => (inputEl || confirmBtn).focus(), 30);
  return overlay;
}

// --- Toasts ---
/*
 * The outcome of everything the panel does, in the same words Source Control
 * uses. { kind: 'info' | 'success' | 'warning' | 'error', description, undo,
 * undoLabel, duration }. Three at most; an error stays longer.
 */
function showToast(text, opts) {
  opts = opts || {};
  const host = document.getElementById('toast-host');
  const kind = opts.kind || 'info';
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const icon = kind === 'error' ? 'alert' : kind === 'warning' ? 'warn' : kind === 'success' ? 'check-circle' : 'info';
  el.innerHTML = ic(icon) + '<div class="toast-text"><span></span>' + (opts.description ? '<small></small>' : '') + '</div>'
    + (opts.undo ? '<button type="button" class="btn xs outline" data-toast="undo">' + escHtml(opts.undoLabel || 'Undo') + '</button>' : '')
    + '<button type="button" class="tool" data-toast="close" aria-label="Dismiss">' + ic('x', 'ic-sm') + '</button>';
  el.querySelector('.toast-text span').textContent = String(text);
  if (opts.description) el.querySelector('.toast-text small').textContent = String(opts.description);
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  const timer = setTimeout(() => el.remove(), opts.duration || (kind === 'error' ? 12000 : 7000));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-toast]');
    if (!b) return;
    clearTimeout(timer);
    el.remove();
    if (b.dataset.toast === 'undo' && opts.undo) opts.undo();
  });
}

// --- Requests ---
/*
 * One message to the host whose outcome comes back as an actionResult named
 * after it. The host handles messages concurrently, so two requests of one
 * action can be answered in either order: each carries an id that its answer
 * echoes, and that id is what hands the answer back to the code that asked.
 */
function request(msg, action, cb) {
  msg.reqId = ++lastRequestId;
  (pendingActions[action] = pendingActions[action] || {})[msg.reqId] = cb || null;
  vscode.postMessage(msg);
}

/** The callback an answer is for, taken out: null when asked silently, undefined when nothing here asked. */
function takePending(action, reqId) {
  const waiting = pendingActions[action];
  if (!waiting || !(reqId in waiting)) return undefined;
  const cb = waiting[reqId];
  delete waiting[reqId];
  return cb;
}

function gitAction(action, args, cb) {
  request({ command: 'gitAction', action, args }, action, cb);
}

function setBusy(name, on) {
  if (on) state.busy[name] = true;
  else delete state.busy[name];
  renderBusy();
}

function anyBusy() { return Object.keys(state.busy).length > 0; }
`;
}
