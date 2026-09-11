/**
 * Reflog panel — everywhere HEAD has been, and the way back.
 *
 * This is the undo surface for the destructive operations the other panels
 * offer: a rebase that went wrong, a branch deleted by mistake, a reset that
 * took the wrong commit. The commits are all still in the object store; the
 * reflog is the only listing that still names them.
 *
 * The safe recovery is offered first (create a branch at that commit) because
 * it cannot lose anything, and `reset --hard` is behind a confirmation *and* a
 * clean-worktree check — it silently discards uncommitted work otherwise, which
 * is exactly the mistake this panel exists to undo.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { VscodeApi } from "./git-exec.ts";
import { assertValidRef, spawnGit } from "./git-exec.ts";
import { openPanel } from "./panel-registry.ts";
import { registerViewCommand } from "./register-view-command.ts";
import { REFLOG_FORMAT, assertValidSelector, parseReflog } from "./reflog-parser.ts";
import { shellHtml } from "./webview-shell.ts";

const VIEW_TYPE = "git-graph.reflog";
const MAX_ENTRIES = 300;

export function registerReflogView(context: ExtensionContext, vscode: VscodeApi): void {
  registerViewCommand({
    context,
    vscode,
    command: VIEW_TYPE,
    label: "Reflog",
    open: (projectPath) => openReflogView(vscode, context, projectPath),
  });
}

export function openReflogView(
  vscode: VscodeApi,
  _context: ExtensionContext,
  projectPath: string,
): void {
  const dirName = projectPath.split(/[\\/]/).filter(Boolean).pop() || "Reflog";

  const panel = openPanel({
    vscode,
    viewType: VIEW_TYPE,
    title: `Reflog: ${dirName}`,
    projectPath,
    html: getReflogHtml(),
    onMessage: async (raw) => {
      const msg = raw as Record<string, any>;
      try {
        switch (msg.command) {
          case "ready":
          case "refresh":
            await sendEntries();
            break;

          case "createBranch":
            await createBranch(msg.selector, msg.name);
            break;

          case "checkout":
            await checkoutDetached(msg.selector);
            break;

          case "resetHard":
            await resetHard(msg.selector);
            break;
        }
      } catch (e) {
        await panel.webview.postMessage({
          command: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  });

  async function sendEntries(): Promise<void> {
    const [logRes, headRes] = await Promise.all([
      spawnGit(vscode, ["reflog", REFLOG_FORMAT, `--max-count=${MAX_ENTRIES}`], projectPath, 60_000),
      spawnGit(vscode, ["rev-parse", "--abbrev-ref", "HEAD"], projectPath),
    ]);
    if (logRes.exitCode !== 0) {
      throw new Error(logRes.stderr.trim() || "Could not read the reflog.");
    }
    const entries = parseReflog(logRes.stdout);
    await panel.webview.postMessage({
      command: "loadEntries",
      data: {
        entries,
        branch: headRes.exitCode === 0 ? headRes.stdout.trim() : null,
        truncated: entries.length === MAX_ENTRIES,
      },
    });
  }

  async function createBranch(rawSelector: unknown, rawName: unknown): Promise<void> {
    const selector = assertValidSelector(rawSelector);
    const name = assertValidRef(rawName, "branch name");
    const res = await spawnGit(vscode, ["branch", "--", name, selector], projectPath);
    await finish(res, `Created branch ${name}.`);
  }

  async function checkoutDetached(rawSelector: unknown): Promise<void> {
    const selector = assertValidSelector(rawSelector);
    const res = await spawnGit(vscode, ["checkout", "--detach", selector], projectPath, 60_000);
    await finish(res, "Checked out in detached HEAD.");
  }

  async function resetHard(rawSelector: unknown): Promise<void> {
    const selector = assertValidSelector(rawSelector);

    // `reset --hard` throws away the working tree without asking. Refusing on a
    // dirty tree is the difference between undoing a mistake and making a worse
    // one — there is no reflog for uncommitted work.
    const status = await spawnGit(vscode, ["status", "--porcelain"], projectPath);
    if (status.exitCode === 0 && status.stdout.trim()) {
      throw new Error(
        "This would discard uncommitted changes, which nothing can recover. Commit or stash them first.",
      );
    }

    const res = await spawnGit(vscode, ["reset", "--hard", selector], projectPath, 60_000);
    await finish(res, `Reset to ${selector}.`);
  }

  async function finish(res: { exitCode: number; stdout: string; stderr: string }, okMessage: string): Promise<void> {
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || "git refused the command.");
    }
    await panel.webview.postMessage({
      command: "actionResult",
      data: { message: okMessage, output: (res.stdout + res.stderr).trim() },
    });
    await sendEntries();
  }
}

function getReflogHtml(): string {
  return shellHtml({
    toolbar: `
      <div class="toolbar-left">
        <span class="toolbar-title">Reflog</span>
        <span class="toolbar-sub" id="branch-label"></span>
      </div>
      <div class="toolbar-right">
        <input type="text" id="filter" placeholder="Filter" />
        <select id="kind">
          <option value="">All actions</option>
          <option value="commit">commit</option>
          <option value="checkout">checkout</option>
          <option value="reset">reset</option>
          <option value="rebase">rebase</option>
          <option value="merge">merge</option>
          <option value="pull">pull</option>
          <option value="clone">clone</option>
        </select>
        <button id="btn-refresh">Refresh</button>
      </div>`,
    body: `
      <div id="list" class="scroll"></div>
      <div class="foot">
        Every commit listed here still exists, even if no branch points at it any more.
        <b>Branch here</b> is the safe way back — it only adds a name.
      </div>
      <div id="output" class="output hidden"></div>`,
    css: `
#filter { width: 130px; }

.rl-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.rl-row:hover { background: var(--surface-hover); }
.rl-sel { flex-shrink: 0; font-family: ui-monospace, monospace; font-size: 10px; color: var(--subtext); min-width: 62px; }
.rl-main { flex: 1; min-width: 0; }
.rl-action { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-subject { color: var(--subtext); font-size: 11px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-meta { color: var(--subtext); font-size: 10px; margin-top: 2px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.rl-hash { font-family: ui-monospace, monospace; }
.rl-kind { flex-shrink: 0; font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--surface); border: 1px solid var(--border2); }
.rl-kind.k-reset, .rl-kind.k-rebase { color: var(--red); }
.rl-kind.k-commit { color: var(--green); }
.rl-kind.k-checkout { color: var(--blue); }
.rl-acts { display: flex; gap: 4px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.rl-acts button { font-size: 10px; }

.rl-confirm { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--surface); }
.rl-confirm label { font-size: 11px; color: var(--subtext); }
.rl-confirm input { flex: 1; min-width: 140px; }
.rl-confirm.danger-zone { border-left: 3px solid var(--red); }

.foot { padding: 6px 10px; border-top: 1px solid var(--border); color: var(--subtext); font-size: 10px; flex-shrink: 0; line-height: 1.5; }
.output { border-top: 1px solid var(--border2); background: var(--surface); padding: 8px 10px; font-family: ui-monospace, monospace; font-size: 10px; white-space: pre-wrap; max-height: 28vh; overflow: auto; flex-shrink: 0; }
.output.ok { color: var(--green); }
.output.fail { color: var(--red); }

/* Actions must be reachable without a hover, and big enough to hit. */
@media (max-width: 720px) {
  .rl-row { flex-wrap: wrap; }
  .rl-acts { width: 100%; justify-content: flex-start; }
  .rl-acts button { min-height: 32px; padding: 0 10px; }
}`,
    script: `
const state = { entries: [], branch: null, truncated: false, filter: '', kind: '', pending: null };

const el = {
  list: document.getElementById('list'),
  branchLabel: document.getElementById('branch-label'),
  filter: document.getElementById('filter'),
  kind: document.getElementById('kind'),
  output: document.getElementById('output'),
};

function visible() {
  const needle = state.filter.trim().toLowerCase();
  return state.entries.filter((e) => {
    if (state.kind && e.kind !== state.kind) return false;
    if (!needle) return true;
    return (e.action + ' ' + e.subject + ' ' + e.hash + ' ' + e.selector).toLowerCase().includes(needle);
  });
}

/** The expanded row that collects the one answer an action needs. */
function confirmHtml(entry) {
  const p = state.pending;
  if (!p || p.selector !== entry.selector) return '';
  const short = entry.hash.slice(0, 7);
  if (p.kind === 'branch') {
    return '<div class="rl-confirm">'
      + '<label>New branch at ' + escHtml(short) + '</label>'
      + '<input type="text" id="confirm-input" placeholder="branch-name" />'
      + '<button data-act="do-branch" class="primary">Create</button>'
      + '<button data-act="cancel">Cancel</button>'
      + '</div>';
  }
  return '<div class="rl-confirm danger-zone">'
    + '<label>This moves ' + escHtml(state.branch || 'HEAD') + ' to ' + escHtml(short)
      + ' and rewrites the working tree. Type <b>' + escHtml(short) + '</b> to confirm.</label>'
    + '<input type="text" id="confirm-input" placeholder="' + escHtml(short) + '" />'
    + '<button data-act="do-reset" class="danger">Reset --hard</button>'
    + '<button data-act="cancel">Cancel</button>'
    + '</div>';
}

function render() {
  const rows = visible();
  if (!rows.length) {
    el.list.innerHTML = '<div class="empty">' + (state.entries.length
      ? 'Nothing in the reflog matches this filter.'
      : 'This repository has no reflog yet.') + '</div>';
    return;
  }
  el.list.innerHTML = rows.map((e) =>
    '<div class="rl-row" data-sel="' + escHtml(e.selector) + '" data-hash="' + escHtml(e.hash) + '">'
      + '<span class="rl-sel">' + escHtml(e.selector) + '</span>'
      + '<div class="rl-main">'
        + '<div class="rl-action">' + escHtml(e.action) + '</div>'
        + (e.subject && e.subject !== e.action ? '<div class="rl-subject">' + escHtml(e.subject) + '</div>' : '')
        + '<div class="rl-meta">' + avatarHtml(e.author, e.authorEmail)
          + '<span>' + escHtml(e.author) + '</span>'
          + '<span>' + escHtml(relTime(e.authorDate)) + '</span>'
          + '<span class="rl-hash">' + escHtml(e.hash.slice(0, 7)) + '</span>'
          + '<span class="rl-kind k-' + escHtml(e.kind) + '">' + escHtml(e.kind || 'other') + '</span>'
        + '</div>'
      + '</div>'
      + '<div class="rl-acts">'
        + '<button data-act="branch">Branch here</button>'
        + '<button data-act="checkout">Checkout</button>'
        + '<button data-act="reset" class="danger">Reset --hard</button>'
      + '</div>'
    + '</div>'
    + confirmHtml(e)).join('')
    + (state.truncated ? '<div class="fh-end">Showing the most recent ' + rows.length + ' entries.</div>' : '');
}

el.list.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const row = btn.closest('.rl-row, .rl-confirm');
  if (!row) return;
  const act = btn.dataset.act;
  clearError();

  if (act === 'cancel') { state.pending = null; render(); return; }

  if (act === 'do-branch') {
    const name = (el.list.querySelector('#confirm-input') || {}).value || '';
    if (!name.trim()) { showError('Enter a name for the new branch.'); return; }
    vscode.postMessage({ command: 'createBranch', selector: state.pending.selector, name: name.trim() });
    state.pending = null;
    render();
    return;
  }

  if (act === 'do-reset') {
    const typed = ((el.list.querySelector('#confirm-input') || {}).value || '').trim();
    if (typed !== state.pending.hash.slice(0, 7)) {
      showError('That did not match ' + state.pending.hash.slice(0, 7) + ' — nothing was changed.');
      return;
    }
    vscode.postMessage({ command: 'resetHard', selector: state.pending.selector });
    state.pending = null;
    render();
    return;
  }

  const selector = row.dataset.sel;
  const hash = row.dataset.hash;
  if (act === 'checkout') {
    vscode.postMessage({ command: 'checkout', selector: selector });
    return;
  }
  // Branch and reset both need a typed answer, and a sandboxed webview has no
  // prompt(): the frontend mounts these panels with sandbox="allow-scripts"
  // alone, so every modal API is a silent no-op. The row expands instead.
  state.pending = { kind: act, selector: selector, hash: hash };
  render();
  const box = el.list.querySelector('#confirm-input');
  if (box) box.focus();
});

el.list.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.target.id !== 'confirm-input') return;
  e.preventDefault();
  const primary = el.list.querySelector('.rl-confirm button[data-act^="do-"]');
  if (primary) primary.click();
});

el.filter.addEventListener('input', () => { state.filter = el.filter.value; render(); });
el.kind.addEventListener('change', () => { state.kind = el.kind.value; render(); });
document.getElementById('btn-refresh').addEventListener('click', () => {
  clearError();
  vscode.postMessage({ command: 'refresh' });
});

function showOutput(text, ok) {
  el.output.textContent = text;
  el.output.classList.remove('hidden', 'ok', 'fail');
  el.output.classList.add(ok ? 'ok' : 'fail');
}

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.command) {
    case 'loadEntries':
      state.entries = msg.data.entries || [];
      state.branch = msg.data.branch;
      state.truncated = !!msg.data.truncated;
      el.branchLabel.textContent = state.branch ? 'HEAD → ' + state.branch : '';
      render();
      break;
    case 'actionResult':
      showOutput(msg.data.message + (msg.data.output ? '\\n' + msg.data.output : ''), true);
      break;
    case 'error':
      showError(msg.message);
      break;
  }
});

vscode.postMessage({ command: 'ready' });`,
  });
}
