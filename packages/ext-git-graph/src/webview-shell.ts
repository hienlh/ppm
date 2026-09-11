/**
 * Shared chrome for the panels added in v0.2.0 (blame, file history, compare,
 * interactive rebase).
 *
 * The graph panel keeps its own self-contained HTML — it predates this shell and
 * its CSS is tuned to the graph canvas. This shell only carries what the four
 * newer panels have in common: the theme tokens, base typography, a toolbar, and
 * the `acquireVsCodeApi` bridge. Webviews are sandboxed with `allow-scripts`
 * only, so everything is inlined.
 */

/**
 * Dark values, emitted twice by design.
 *
 * A panel is a sandboxed iframe: it cannot see the app's theme, so on its own
 * the only thing it can ask is prefers-color-scheme — the *OS* setting, which
 * left every panel dark inside a light app. The host now stamps
 * data-ppm-theme on the panel's own html element and injects the app's tokens
 * (src/web/components/extensions/webview-theme.ts), so that attribute decides;
 * the media query stays as the answer for a host that says nothing.
 */
const DARK_TOKENS = `
  --bg: #16171c; --surface: #1d1f26; --text: #ecedf0; --subtext: #a2a5b0; --subtle: #6b6f7c;
  --border: #262932; --border2: #383c48; --selected: #1e293b;
`;

/** Theme tokens, kept in sync with the graph panel's palette. */
/**
 * The font stacks every panel uses.
 *
 * A panel cannot use the ones the app bundles. It is a sandboxed iframe with an
 * opaque origin, so a `@font-face` pointing at `/assets/` is a cross-origin
 * fetch the font would need CORS headers to answer — and the file name carries
 * Vite's content hash, which the extension has no way to know. So the stack
 * asks for the same typefaces *by name* and gets them when they are installed
 * on the host, which is the one case where the panel and the app match exactly.
 *
 * Everything after that is for the host where they are not. It matters, because
 * the obvious stack is wrong on the platform PPM is most often self-hosted on:
 * `-apple-system` and `Segoe UI` both miss on Linux and a generic `sans-serif`
 * can resolve to Liberation *Serif* through fontconfig, which is how these
 * panels came to be set in an Arial clone with serif digits underneath.
 * `system-ui` asks the desktop what it actually uses; the named families below
 * it are for the hosts where even that keyword misses.
 */
export const FONT_TOKENS = `
  --ui-font: 'Geist', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', 'Noto Sans', Cantarell, 'Helvetica Neue', Arial, sans-serif;
  --mono-font: 'Monaspace Argon', 'Monaspace Argon Var', ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Noto Sans Mono', 'DejaVu Sans Mono', Consolas, monospace;
`;

export const SHELL_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #ffffff; --surface: #f4f4f5; --text: #09090b; --subtext: #71717a; --subtle: #a1a1aa;
  --border: #e4e4e7; --border2: #d4d4d8; --blue: #3b82f6; --red: #ef4444; --green: #22c55e;
  --yellow: #eab308; --purple: #8b5cf6; --orange: #f97316;
  --selected: #eff6ff;
  /* Derived, never injected: the app has no hover token and some of its themes
     give the same colour to both panel surfaces, which would leave a hovered
     row looking untouched. A tint of the text colour flips with the mode. */
  --surface-hover: color-mix(in srgb, var(--text) 8%, transparent);
  ${FONT_TOKENS}
}
:root[data-ppm-theme="dark"] { ${DARK_TOKENS} }
@media (prefers-color-scheme: dark) {
  :root:not([data-ppm-theme="light"]) { ${DARK_TOKENS} }
}
body { font-family: var(--ui-font); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; background: var(--bg); color: var(--text); font-size: 12px; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
#app { display: flex; flex-direction: column; height: 100vh; min-height: 0; }
code, .mono { font-family: var(--mono-font); }

#toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 4px; min-width: 0; }
.toolbar-title { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.toolbar-sub { color: var(--subtext); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

button { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 3px 8px; font-size: 11px; cursor: pointer; min-width: 24px; min-height: 24px; transition: background 0.15s, border-color 0.15s; }
button:hover { background: var(--surface-hover); border-color: var(--border2); }
button:active { background: var(--surface); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
button.danger { border-color: var(--red); color: var(--red); }
select, input[type=text], input[type=search] { background: var(--bg); color: var(--text); border: 1px solid var(--border2); border-radius: 4px; padding: 3px 6px; font-size: 11px; outline: none; }
select:focus, input:focus { border-color: var(--blue); }

.scroll { flex: 1; overflow: auto; min-height: 0; }
.empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--subtext); font-size: 12px; padding: 24px; text-align: center; }
.spinner { width: 16px; height: 16px; border: 2px solid var(--border2); border-top-color: var(--blue); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.banner { padding: 6px 10px; font-size: 11px; border-bottom: 1px solid var(--border); background: rgba(234,179,8,0.12); color: var(--text); display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.banner.error { background: rgba(239,68,68,0.12); }
.hidden { display: none !important; }

/* Author chip — initials only. Rendering a real avatar would mean sending the
   committer's email to a third-party service (gravatar), which a self-hosted
   tool must not do silently. */
.avatar { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 700; color: #fff; flex-shrink: 0; letter-spacing: -0.2px; }

/* Touch devices get taller rows — matches the graph panel's coarse-pointer rule */
@media (pointer: coarse) {
  button { min-height: 32px; padding: 5px 10px; }
  .row { min-height: 40px; }
}
`;

/** Deterministic author colour + initials, shared by every panel. */
export const AVATAR_JS = `
const AVATAR_COLORS = ['#3b82f6','#8b5cf6','#ec4899','#f97316','#22c55e','#14b8a6','#eab308','#ef4444','#6366f1','#0ea5e9'];
function authorInitials(name) {
  const parts = String(name || '?').trim().split(/\\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function authorColor(key) {
  const s = String(key || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function avatarHtml(name, email) {
  return '<span class="avatar" style="background:' + authorColor(email || name) + '">' + escHtml(authorInitials(name)) + '</span>';
}
`;

/** HTML escaping + relative time, needed by every panel's renderer. */
export const SHELL_JS = `
const vscode = acquireVsCodeApi();
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function relTime(ts) {
  const diff = Math.floor(Date.now() / 1000) - Number(ts);
  if (!Number.isFinite(diff)) return '';
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
  if (diff < 31536000) return Math.floor(diff / 2592000) + 'mo ago';
  return Math.floor(diff / 31536000) + 'y ago';
}
function showError(message) {
  const el = document.getElementById('banner');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  el.classList.add('error');
}
function clearError() {
  const el = document.getElementById('banner');
  if (el) el.classList.add('hidden');
}
${AVATAR_JS}
`;

/**
 * Tracked-file picker, shared by the blame and file-history panels.
 *
 * The extension holds the full `git ls-files` list and filters it per keystroke,
 * so the webview never receives a large repo's entire path list. The host panel
 * supplies `onFileChosen` and forwards `loadFiles` to `applyFileList`.
 */
export const FILE_PICKER_CSS = `
.picker { position: absolute; top: 34px; left: 8px; right: 8px; max-width: 620px; z-index: 40; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); display: flex; flex-direction: column; max-height: 60vh; }
.picker input { margin: 8px; }
.picker-list { overflow: auto; min-height: 0; }
.picker-item { padding: 6px 10px; cursor: pointer; font-family: ui-monospace, monospace; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.picker-item:hover, .picker-item.active { background: var(--selected); }
.picker-foot { padding: 6px 10px; border-top: 1px solid var(--border); color: var(--subtext); font-size: 10px; }
@media (pointer: coarse) { .picker-item { padding: 10px; } }
`;

export const FILE_PICKER_HTML = `
      <div id="picker" class="picker hidden">
        <input id="picker-input" type="search" placeholder="Filter tracked files…" autocomplete="off" />
        <div id="picker-list" class="picker-list"></div>
        <div class="picker-foot" id="picker-foot"></div>
      </div>`;

export const FILE_PICKER_JS = `
const picker = {
  root: document.getElementById('picker'),
  input: document.getElementById('picker-input'),
  list: document.getElementById('picker-list'),
  foot: document.getElementById('picker-foot'),
  files: [],
  idx: 0,
  timer: undefined,
};

function openFilePicker() {
  picker.root.classList.remove('hidden');
  picker.input.value = '';
  picker.input.focus();
  vscode.postMessage({ command: 'requestFiles', query: '' });
}
function closeFilePicker() { picker.root.classList.add('hidden'); }
function isFilePickerOpen() { return !picker.root.classList.contains('hidden'); }

function applyFileList(data) {
  picker.files = data.files || [];
  picker.idx = 0;
  renderFilePicker();
  picker.foot.textContent = picker.files.length + ' of ' + data.total + ' tracked files';
}

function renderFilePicker() {
  picker.list.innerHTML = picker.files.map((f, i) =>
    '<div class="picker-item' + (i === picker.idx ? ' active' : '') + '" data-file="' + escHtml(f) + '">' + escHtml(f) + '</div>'
  ).join('') || '<div class="picker-foot">No tracked file matches.</div>';
}

picker.input.addEventListener('input', () => {
  clearTimeout(picker.timer);
  picker.timer = setTimeout(() => {
    vscode.postMessage({ command: 'requestFiles', query: picker.input.value });
  }, 120);
});

picker.input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeFilePicker(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    picker.idx = Math.max(0, Math.min(picker.files.length - 1, picker.idx + (e.key === 'ArrowDown' ? 1 : -1)));
    renderFilePicker();
    const active = picker.list.querySelector('.picker-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter') {
    const file = picker.files[picker.idx];
    if (file) { closeFilePicker(); onFileChosen(file); }
  }
});

picker.list.addEventListener('click', (e) => {
  const item = e.target.closest('.picker-item');
  if (item) { closeFilePicker(); onFileChosen(item.dataset.file); }
});
`;

export interface ShellOptions {
  /** Toolbar markup (left/right groups). */
  toolbar: string;
  /** Panel body markup, placed inside `#app` below the toolbar. */
  body: string;
  /** Panel-specific CSS appended after the shell CSS. */
  css?: string;
  /** Panel-specific JS appended after the shell JS. */
  script: string;
}

export function shellHtml(options: ShellOptions): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${SHELL_CSS}
${options.css ?? ""}
</style>
</head>
<body>
<div id="app">
  <div id="toolbar">${options.toolbar}</div>
  <div id="banner" class="banner hidden"></div>
${options.body}
</div>
<script>
${SHELL_JS}
${options.script}
</script>
</body>
</html>`;
}
