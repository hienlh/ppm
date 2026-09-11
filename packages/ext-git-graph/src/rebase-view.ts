/**
 * Interactive rebase panel — drag to reorder, then reword/edit/squash/fixup/drop.
 *
 * See `rebase-todo.ts` for how the plan reaches git, and how a reword's message
 * gets there without an interactive editor.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { VscodeApi } from "./git-exec.ts";
import { assertValidHash, assertValidRef, spawnGit } from "./git-exec.ts";
import { openPanel } from "./panel-registry.ts";
import { registerViewCommand } from "./register-view-command.ts";
import { takePendingTarget } from "./panel-nav.ts";
import { detectMergeState } from "./git-state.ts";
import { FILE_HISTORY_FORMAT, parseFileHistory } from "./file-history-parser.ts";
import type { RebaseTodoEntry } from "./rebase-todo.ts";
import { SEQUENCE_EDITOR, TODO_ENV_VAR, buildRebaseTodo, isRebaseAction } from "./rebase-todo.ts";
import { shellHtml } from "./webview-shell.ts";

const VIEW_TYPE = "git-graph.interactiveRebase";
/** Interactive rebases longer than this are a sign something else is wanted. */
const MAX_PLAN_SIZE = 100;

export interface RebaseTarget {
  /** Rebase the commits after this one, i.e. the base. */
  base?: string;
}

export function registerRebaseView(context: ExtensionContext, vscode: VscodeApi): void {
  registerViewCommand({
    context,
    vscode,
    command: VIEW_TYPE,
    label: "Interactive Rebase",
    open: (projectPath, args) => {
      const base = typeof args[1] === "string" ? args[1] : undefined;
      openRebaseView(vscode, context, projectPath, base ? { base } : undefined);
    },
  });
}

export function openRebaseView(
  vscode: VscodeApi,
  _context: ExtensionContext,
  projectPath: string,
  target?: RebaseTarget,
): void {
  const dirName = projectPath.split(/[\\/]/).filter(Boolean).pop() || "Rebase";
  const initialTarget = target ?? takePendingTarget<RebaseTarget>(VIEW_TYPE, projectPath);

  const panel = openPanel({
    vscode,
    viewType: VIEW_TYPE,
    title: `Interactive Rebase: ${dirName}`,
    projectPath,
    html: getRebaseHtml(),
    onMessage: async (raw) => {
      const msg = raw as Record<string, any>;
      try {
        switch (msg.command) {
          case "ready":
            await sendState(initialTarget?.base);
            break;

          case "requestPlan":
            await sendState(msg.base ? String(msg.base) : undefined, msg.count);
            break;

          case "runRebase":
            await runRebase(msg.base, msg.entries);
            break;

          case "rebaseAction": {
            const action = String(msg.action);
            const flag = action === "continue" ? "--continue"
              : action === "abort" ? "--abort"
                : action === "skip" ? "--skip"
                  : null;
            if (!flag) throw new Error(`Unknown rebase action: ${action}`);
            const res = await spawnGit(vscode, ["rebase", flag], projectPath, 120_000);
            await panel.webview.postMessage({
              command: "rebaseResult",
              data: {
                ok: res.exitCode === 0,
                output: (res.stdout + res.stderr).trim(),
              },
            });
            await sendState();
            break;
          }
        }
      } catch (e) {
        await panel.webview.postMessage({
          command: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  });

  async function sendState(base?: string, rawCount?: unknown): Promise<void> {
    const mergeState = await detectMergeState(vscode, projectPath);
    const inProgress = mergeState?.type ?? null;
    const branchRes = await spawnGit(vscode, ["rev-parse", "--abbrev-ref", "HEAD"], projectPath);
    const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : null;

    if (inProgress) {
      await panel.webview.postMessage({
        command: "loadState",
        data: {
          inProgress,
          progress: mergeState?.progress ?? null,
          branch,
          commits: [],
          base: null,
          upstream: null,
        },
      });
      return;
    }

    // Default plan: the commits this branch has that its upstream does not —
    // the ones that are still safe to rewrite.
    let resolvedBase = base;
    let upstream: string | null = null;
    const upstreamRes = await spawnGit(
      vscode,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      projectPath,
    );
    if (upstreamRes.exitCode === 0) upstream = upstreamRes.stdout.trim() || null;

    const count = Number(rawCount);
    if (!resolvedBase && Number.isInteger(count) && count > 0) {
      const head = await spawnGit(vscode, ["rev-parse", `HEAD~${Math.min(count, MAX_PLAN_SIZE)}`], projectPath);
      if (head.exitCode === 0) resolvedBase = head.stdout.trim();
    }
    if (!resolvedBase && upstream) {
      const mergeBase = await spawnGit(vscode, ["merge-base", "HEAD", assertValidRef(upstream, "upstream")], projectPath);
      if (mergeBase.exitCode === 0) resolvedBase = mergeBase.stdout.trim();
    }

    let commits: ReturnType<typeof parseFileHistory> = [];
    if (resolvedBase) {
      const validBase = assertValidHash(resolvedBase);
      const logRes = await spawnGit(vscode, [
        "log", `--format=${FILE_HISTORY_FORMAT}`, `--max-count=${MAX_PLAN_SIZE}`,
        `${validBase}..HEAD`,
      ], projectPath, 60_000);
      if (logRes.exitCode === 0) commits = parseFileHistory(logRes.stdout);
    }

    await panel.webview.postMessage({
      command: "loadState",
      data: { inProgress: null, branch, upstream, base: resolvedBase ?? null, commits },
    });
  }

  async function runRebase(rawBase: unknown, rawEntries: unknown): Promise<void> {
    const base = assertValidHash(rawBase);
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
      throw new Error("The rebase plan is empty.");
    }
    if (rawEntries.length > MAX_PLAN_SIZE) {
      throw new Error(`This plan has ${rawEntries.length} commits; the limit is ${MAX_PLAN_SIZE}.`);
    }

    // The panel lists newest-first; git's todo is oldest-first.
    const entries: RebaseTodoEntry[] = rawEntries
      .slice()
      .reverse()
      .map((raw) => {
        const e = raw as Record<string, unknown>;
        if (!isRebaseAction(e.action)) throw new Error(`Invalid rebase action: "${String(e.action)}"`);
        return {
          hash: assertValidHash(e.hash),
          action: e.action,
          subject: typeof e.subject === "string" ? e.subject : undefined,
          message: typeof e.message === "string" ? e.message : undefined,
        };
      });

    const { todo, env } = buildRebaseTodo(entries);

    await panel.webview.postMessage({ command: "running" });
    const res = await spawnGit(
      vscode,
      ["rebase", "-i", base],
      projectPath,
      180_000,
      {
        ...env,
        [TODO_ENV_VAR]: todo,
        GIT_SEQUENCE_EDITOR: SEQUENCE_EDITOR,
        // Any commit-message editor git reaches for during squash/fixup accepts
        // the message git already composed. A reword supplies its message on the
        // `exec` line instead, so nothing here ever needs human input.
        GIT_EDITOR: "true",
      },
    );

    await panel.webview.postMessage({
      command: "rebaseResult",
      data: { ok: res.exitCode === 0, output: (res.stdout + res.stderr).trim() },
    });
    await sendState();
  }
}

function getRebaseHtml(): string {
  return shellHtml({
    toolbar: `
      <div class="toolbar-left">
        <span class="toolbar-title" id="branch-label"></span>
        <span class="toolbar-sub" id="base-label"></span>
      </div>
      <div class="toolbar-right">
        <label class="range-label">Last <input type="text" id="count" class="count-input" placeholder="n" inputmode="numeric" /> commits</label>
        <button id="btn-apply-count">Load</button>
        <button id="btn-reset">Reset plan</button>
        <button id="btn-run" class="primary" disabled>Start rebase</button>
      </div>`,
    body: `
      <div id="progress" class="banner hidden">
        <span id="progress-text"></span>
        <span style="flex:1"></span>
        <button data-rb="continue">Continue</button>
        <button data-rb="skip">Skip</button>
        <button data-rb="abort" class="danger">Abort</button>
      </div>
      <div id="list" class="scroll"></div>
      <div class="foot">
        Drag a row to reorder. <b>squash</b> folds a commit into the one below it in this
        list and keeps both messages; <b>fixup</b> folds it in and discards its message.
        <b>reword</b> asks for the new message here, up front. <b>edit</b> stops the rebase at
        that commit so you can change it — stage what you want, then press Continue.
      </div>
      <div id="output" class="output hidden"></div>`,
    css: `
.range-label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--subtext); white-space: nowrap; }
.count-input { width: 44px; }

.rb-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); background: var(--bg); }
.rb-row[draggable=true] { cursor: grab; }
.rb-row.dragging { opacity: 0.4; }
.rb-row.drop-before { box-shadow: inset 0 2px 0 var(--blue); }
.rb-row.drop-after { box-shadow: inset 0 -2px 0 var(--blue); }
.rb-row.act-drop { opacity: 0.5; }
.rb-row.act-drop .rb-subject { text-decoration: line-through; }
.rb-row.act-squash, .rb-row.act-fixup { border-left: 3px solid var(--purple); }
.rb-row.act-reword, .rb-row.act-edit { border-left: 3px solid var(--blue); }
.rb-reword { padding: 6px 10px 8px 34px; border-bottom: 1px solid var(--border); background: var(--surface); }
.rb-reword textarea { width: 100%; box-sizing: border-box; resize: vertical; font-size: 12px; line-height: 1.4; }
.rb-grip { color: var(--subtle); flex-shrink: 0; user-select: none; font-size: 14px; line-height: 1; }
.rb-main { flex: 1; min-width: 0; }
.rb-subject { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rb-meta { color: var(--subtext); font-size: 10px; margin-top: 2px; display: flex; gap: 6px; align-items: center; }
.rb-hash { font-family: ui-monospace, monospace; }
.rb-action { flex-shrink: 0; }
.rb-move { display: flex; flex-direction: column; gap: 1px; flex-shrink: 0; }
.rb-move button { padding: 0 4px; min-height: 14px; min-width: 18px; font-size: 9px; line-height: 1.2; }

.foot { padding: 6px 10px; border-top: 1px solid var(--border); color: var(--subtext); font-size: 10px; flex-shrink: 0; line-height: 1.5; }
.output { border-top: 1px solid var(--border2); background: var(--surface); padding: 8px 10px; font-family: ui-monospace, monospace; font-size: 10px; white-space: pre-wrap; max-height: 28vh; overflow: auto; flex-shrink: 0; }
.output.ok { color: var(--green); }
.output.fail { color: var(--red); }

/* Touch devices cannot drag HTML5-style, so the arrow buttons are the path */
@media (pointer: coarse) { .rb-move button { min-height: 22px; min-width: 28px; font-size: 11px; } }`,
    script: `
const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
const state = { base: null, branch: null, upstream: null, plan: [], inProgress: null, dragIdx: null };

const el = {
  list: document.getElementById('list'),
  branchLabel: document.getElementById('branch-label'),
  baseLabel: document.getElementById('base-label'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  output: document.getElementById('output'),
  btnRun: document.getElementById('btn-run'),
  count: document.getElementById('count'),
};

function render() {
  if (state.inProgress) {
    el.list.innerHTML = '<div class="empty">A rebase is already in progress. Resolve the conflict in the editor, then Continue — or Abort to go back.</div>';
    el.btnRun.disabled = true;
    return;
  }
  if (!state.plan.length) {
    el.list.innerHTML = '<div class="empty">' + (state.base
      ? 'This branch has no commits above its base.'
      : 'No upstream branch to compare against. Enter how many recent commits to rebase.') + '</div>';
    el.btnRun.disabled = true;
    return;
  }
  el.btnRun.disabled = false;
  el.list.innerHTML = state.plan.map((c, i) =>
    '<div class="rb-row act-' + c.action + '" draggable="true" data-idx="' + i + '">'
      + '<span class="rb-grip">⠿</span>'
      + '<div class="rb-move">'
        + '<button data-move="up" data-idx="' + i + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>▲</button>'
        + '<button data-move="down" data-idx="' + i + '" title="Move down"' + (i === state.plan.length - 1 ? ' disabled' : '') + '>▼</button>'
      + '</div>'
      + '<div class="rb-main">'
        + '<div class="rb-subject">' + escHtml(c.subject) + '</div>'
        + '<div class="rb-meta">' + avatarHtml(c.author, c.authorEmail)
          + '<span>' + escHtml(c.author) + '</span>'
          + '<span>' + escHtml(relTime(c.authorDate)) + '</span>'
          + '<span class="rb-hash">' + escHtml(c.hash.slice(0, 7)) + '</span>'
        + '</div>'
      + '</div>'
      + '<select class="rb-action" data-idx="' + i + '">'
        + ACTIONS.map((a) => '<option value="' + a + '"' + (a === c.action ? ' selected' : '') + '>' + a + '</option>').join('')
      + '</select>'
    + '</div>'
    + (c.action === 'reword'
      ? '<div class="rb-reword"><textarea data-msg="' + i + '" rows="3" placeholder="New commit message">'
          + escHtml(c.message === undefined ? c.subject : c.message) + '</textarea></div>'
      : '')).join('');
}

/* --- Reordering --- */
function move(from, to) {
  if (to < 0 || to >= state.plan.length) return;
  const [item] = state.plan.splice(from, 1);
  state.plan.splice(to, 0, item);
  render();
}

el.list.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-move]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  move(idx, btn.dataset.move === 'up' ? idx - 1 : idx + 1);
});

el.list.addEventListener('change', (e) => {
  const sel = e.target.closest('select.rb-action');
  if (!sel) return;
  const idx = Number(sel.dataset.idx);
  if (state.plan[idx]) {
    // Seed the box with the current subject the first time reword is chosen —
    // most rewords are a tweak, not a rewrite.
    if (sel.value === 'reword' && state.plan[idx].message === undefined) {
      state.plan[idx].message = state.plan[idx].subject;
    }
    state.plan[idx].action = sel.value;
    render();
  }
});

// The input event, not change: a re-render on every keystroke would take the
// caret with it, so the state is updated without touching the DOM.
el.list.addEventListener('input', (e) => {
  const box = e.target.closest('textarea[data-msg]');
  if (!box) return;
  const idx = Number(box.dataset.msg);
  if (state.plan[idx]) state.plan[idx].message = box.value;
});

el.list.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.rb-row');
  if (!row) return;
  state.dragIdx = Number(row.dataset.idx);
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Firefox refuses to start a drag without data set.
  e.dataTransfer.setData('text/plain', row.dataset.idx);
});

el.list.addEventListener('dragover', (e) => {
  const row = e.target.closest('.rb-row');
  if (!row || state.dragIdx === null) return;
  e.preventDefault();
  const rect = row.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  for (const r of el.list.querySelectorAll('.rb-row')) r.classList.remove('drop-before', 'drop-after');
  row.classList.add(after ? 'drop-after' : 'drop-before');
});

el.list.addEventListener('drop', (e) => {
  const row = e.target.closest('.rb-row');
  if (!row || state.dragIdx === null) return;
  e.preventDefault();
  const target = Number(row.dataset.idx);
  const rect = row.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  let to = after ? target + 1 : target;
  if (state.dragIdx < to) to -= 1;
  move(state.dragIdx, to);
  state.dragIdx = null;
});

el.list.addEventListener('dragend', () => {
  state.dragIdx = null;
  for (const r of el.list.querySelectorAll('.rb-row')) r.classList.remove('dragging', 'drop-before', 'drop-after');
});

/* --- Actions --- */
document.getElementById('btn-run').addEventListener('click', () => {
  if (!state.base) { showError('No base commit resolved for this rebase.'); return; }
  const kept = state.plan.filter((c) => c.action !== 'drop');
  if (!kept.length) { showError('Dropping every commit would leave nothing to rebase.'); return; }
  // Oldest kept commit is the last row here (newest-first list).
  const oldestKept = kept[kept.length - 1];
  if (oldestKept.action === 'squash' || oldestKept.action === 'fixup') {
    showError('The oldest kept commit cannot be ' + oldestKept.action + ' — there is no earlier commit to fold it into.');
    return;
  }
  const blank = kept.find((c) => c.action === 'reword' && !(c.message || '').trim());
  if (blank) {
    showError('Reword needs a new message for ' + blank.hash.slice(0, 7) + '.');
    return;
  }
  clearError();
  vscode.postMessage({
    command: 'runRebase',
    base: state.base,
    entries: state.plan.map((c) => ({ hash: c.hash, action: c.action, subject: c.subject, message: c.message })),
  });
});

document.getElementById('btn-reset').addEventListener('click', () => {
  for (const c of state.plan) { c.action = 'pick'; c.message = undefined; }
  vscode.postMessage({ command: 'requestPlan', base: state.base || undefined });
});

document.getElementById('btn-apply-count').addEventListener('click', () => {
  const n = parseInt(el.count.value, 10);
  if (!Number.isInteger(n) || n < 1) { showError('Enter how many recent commits to rebase.'); return; }
  clearError();
  vscode.postMessage({ command: 'requestPlan', count: n });
});

el.progress.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-rb]');
  if (btn) vscode.postMessage({ command: 'rebaseAction', action: btn.dataset.rb });
});

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.command) {
    case 'running':
      clearError();
      el.output.classList.add('hidden');
      el.list.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
      el.btnRun.disabled = true;
      break;
    case 'loadState':
      state.inProgress = msg.data.inProgress;
      state.branch = msg.data.branch;
      state.upstream = msg.data.upstream;
      state.base = msg.data.base;
      state.plan = msg.data.commits.map((c) => ({ ...c, action: 'pick' }));
      el.branchLabel.textContent = state.branch || '(detached HEAD)';
      el.baseLabel.textContent = state.base
        ? 'onto ' + state.base.slice(0, 7) + (state.upstream ? ' · upstream ' + state.upstream : '')
        : '';
      el.progress.classList.toggle('hidden', !state.inProgress);
      if (state.inProgress) {
        el.progressText.textContent = state.inProgress === 'rebase'
          ? 'Rebase in progress' + (msg.data.progress ? ' (' + msg.data.progress + ')' : '') + ' — resolve the conflicts, then Continue.'
          : 'A ' + state.inProgress + ' is in progress — finish or abort it before rebasing.';
      }
      render();
      break;
    case 'rebaseResult':
      el.output.classList.remove('hidden');
      el.output.classList.toggle('ok', msg.data.ok);
      el.output.classList.toggle('fail', !msg.data.ok);
      el.output.textContent = msg.data.output || (msg.data.ok ? 'Rebase finished.' : 'Rebase failed.');
      break;
    case 'error':
      showError(msg.message);
      break;
  }
});

vscode.postMessage({ command: 'ready' });
`,
  });
}
