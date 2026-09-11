/**
 * Compare panel — two refs side by side: the commits between them and the files
 * that differ.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { VscodeApi } from "./git-exec.ts";
import { assertSafeFilePaths, assertValidRef, spawnGit } from "./git-exec.ts";
import { openPanel } from "./panel-registry.ts";
import { registerViewCommand } from "./register-view-command.ts";
import { takePendingTarget } from "./panel-nav.ts";
import { resolveFileTab } from "./ppm-api.ts";
import { FILE_HISTORY_FORMAT, parseFileHistory } from "./file-history-parser.ts";
import type { CompareMode } from "./compare-args.ts";
import { buildRangeSpec, parseAheadBehind, parseNumstatZ, parseRefList } from "./compare-args.ts";
import { shellHtml } from "./webview-shell.ts";

const VIEW_TYPE = "git-graph.compare";
const MAX_COMMITS = 300;

export interface CompareTarget {
  ref1?: string;
  ref2?: string;
}

export function registerCompareView(context: ExtensionContext, vscode: VscodeApi): void {
  registerViewCommand({
    context,
    vscode,
    command: VIEW_TYPE,
    label: "Compare Refs",
    open: (projectPath, args) => {
      const ref1 = typeof args[1] === "string" ? args[1] : undefined;
      const ref2 = typeof args[2] === "string" ? args[2] : undefined;
      openCompareView(vscode, context, projectPath, ref1 || ref2 ? { ref1, ref2 } : undefined);
    },
  });
}

export function openCompareView(
  vscode: VscodeApi,
  _context: ExtensionContext,
  projectPath: string,
  target?: CompareTarget,
): void {
  const dirName = projectPath.split(/[\\/]/).filter(Boolean).pop() || "Compare";
  const initialTarget = target ?? takePendingTarget<CompareTarget>(VIEW_TYPE, projectPath);

  const panel = openPanel({
    vscode,
    viewType: VIEW_TYPE,
    title: `Compare: ${dirName}`,
    projectPath,
    html: getCompareHtml(),
    onMessage: async (raw) => {
      const msg = raw as Record<string, any>;
      try {
        switch (msg.command) {
          case "ready": {
            const refs = await loadRefs();
            const current = await spawnGit(vscode, ["rev-parse", "--abbrev-ref", "HEAD"], projectPath);
            await panel.webview.postMessage({
              command: "init",
              data: {
                refs,
                current: current.exitCode === 0 ? current.stdout.trim() : null,
                target: initialTarget ?? null,
              },
            });
            break;
          }

          case "requestCompare":
            await loadCompare(msg.ref1, msg.ref2, msg.mode === "two-dot" ? "two-dot" : "three-dot");
            break;

          case "openDiff": {
            const filePath = String(msg.filePath || "");
            assertSafeFilePaths([filePath], projectPath);
            const ref1 = assertValidRef(msg.ref1, "ref1");
            const ref2 = assertValidRef(msg.ref2, "ref2");
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            const target = await resolveFileTab(projectPath, filePath);
            await vscode.window.openTab("git-diff", `${fileName} (${ref1}→${ref2})`, target.projectName, {
              ...target,
              ref1,
              ref2,
            });
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

  async function loadRefs() {
    const res = await spawnGit(vscode, [
      "for-each-ref",
      "--format=%(refname)\x1f%(objectname)\x1f%(refname:short)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ], projectPath, 60_000);
    return res.exitCode === 0 ? parseRefList(res.stdout) : [];
  }

  async function loadCompare(rawRef1: unknown, rawRef2: unknown, mode: CompareMode): Promise<void> {
    const ref1 = assertValidRef(rawRef1, "ref1");
    const ref2 = assertValidRef(rawRef2, "ref2");
    await panel.webview.postMessage({ command: "loading" });

    // Commits always use the two-dot range: "what ref2 has that ref1 does not".
    // The file diff honours the mode, since three-dot (against the merge base)
    // is what a review wants and two-dot is what a raw ref-to-ref diff shows.
    const logRange = buildRangeSpec(ref1, ref2, "two-dot");
    const diffRange = buildRangeSpec(ref1, ref2, mode);
    const countRange = buildRangeSpec(ref1, ref2, "three-dot");

    const [logRes, diffRes, countRes] = await Promise.all([
      spawnGit(vscode, [
        "log", `--format=${FILE_HISTORY_FORMAT}`, `--max-count=${MAX_COMMITS}`, logRange,
      ], projectPath, 60_000),
      spawnGit(vscode, ["diff", "--numstat", "-z", diffRange], projectPath, 60_000),
      spawnGit(vscode, ["rev-list", "--left-right", "--count", countRange], projectPath, 60_000),
    ]);

    const failed = [logRes, diffRes, countRes].find((r) => r.exitCode !== 0);
    if (failed) {
      await panel.webview.postMessage({
        command: "error",
        message: failed.stderr.trim() || "Could not compare these refs.",
      });
      return;
    }

    const commits = parseFileHistory(logRes.stdout);
    await panel.webview.postMessage({
      command: "loadCompare",
      data: {
        ref1,
        ref2,
        mode,
        commits,
        files: parseNumstatZ(diffRes.stdout),
        counts: parseAheadBehind(countRes.stdout),
        truncated: commits.length === MAX_COMMITS,
      },
    });
  }
}

function getCompareHtml(): string {
  return shellHtml({
    toolbar: `
      <div class="toolbar-left">
        <select id="ref1" class="ref-select"></select>
        <span class="toolbar-sub">→</span>
        <select id="ref2" class="ref-select"></select>
        <button id="btn-swap" title="Swap the two refs">⇄</button>
        <button id="btn-compare" class="primary">Compare</button>
      </div>
      <div class="toolbar-right">
        <select id="mode">
          <option value="three-dot">Since divergence (…)</option>
          <option value="two-dot">Direct diff (..)</option>
        </select>
        <span class="toolbar-sub" id="counts"></span>
      </div>`,
    body: `
      <div class="split">
        <div class="split-pane">
          <div class="pane-head">Commits</div>
          <div id="commits" class="scroll"></div>
        </div>
        <div class="split-pane">
          <div class="pane-head">Changed files <span id="file-count" class="toolbar-sub"></span></div>
          <div id="files" class="scroll"></div>
        </div>
      </div>`,
    css: `
.ref-select { max-width: 190px; }
.split { flex: 1; display: flex; min-height: 0; }
.split-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--border); }
.split-pane:last-child { border-right: none; }
.pane-head { padding: 4px 10px; font-size: 11px; font-weight: 600; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0; display: flex; gap: 6px; align-items: center; }

.cm-row { padding: 6px 10px; border-bottom: 1px solid var(--border); }
.cm-subject { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cm-meta { color: var(--subtext); font-size: 10px; margin-top: 2px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.cm-hash { font-family: ui-monospace, monospace; }

.f-row { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 11px; }
.f-row:hover { background: var(--surface-hover); }
.f-path { flex: 1; min-width: 0; font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.f-stat { flex-shrink: 0; font-variant-numeric: tabular-nums; font-size: 10px; }
.f-add { color: var(--green); }
.f-del { color: var(--red); }
.f-bin { color: var(--subtext); font-style: italic; font-size: 10px; }
.f-rename { color: var(--purple); font-size: 10px; flex-shrink: 0; }

@media (max-width: 720px) {
  .split { flex-direction: column; }
  .split-pane { border-right: none; border-bottom: 1px solid var(--border); }
}`,
    script: `
const state = { refs: [], ref1: null, ref2: null, mode: 'three-dot' };

const el = {
  ref1: document.getElementById('ref1'),
  ref2: document.getElementById('ref2'),
  mode: document.getElementById('mode'),
  counts: document.getElementById('counts'),
  commits: document.getElementById('commits'),
  files: document.getElementById('files'),
  fileCount: document.getElementById('file-count'),
};

function renderRefOptions() {
  const groups = [
    ['Branches', state.refs.filter((r) => r.kind === 'head')],
    ['Remotes', state.refs.filter((r) => r.kind === 'remote')],
    ['Tags', state.refs.filter((r) => r.kind === 'tag')],
  ];
  const html = groups
    .filter(([, list]) => list.length)
    .map(([label, list]) =>
      '<optgroup label="' + escHtml(label) + '">'
      + list.map((r) => '<option value="' + escHtml(r.name) + '">' + escHtml(r.name) + '</option>').join('')
      + '</optgroup>')
    .join('');
  el.ref1.innerHTML = html;
  el.ref2.innerHTML = html;
}

function compare() {
  state.ref1 = el.ref1.value;
  state.ref2 = el.ref2.value;
  state.mode = el.mode.value;
  if (!state.ref1 || !state.ref2) { showError('Pick two refs to compare.'); return; }
  if (state.ref1 === state.ref2) { showError('Pick two different refs.'); return; }
  vscode.postMessage({ command: 'requestCompare', ref1: state.ref1, ref2: state.ref2, mode: state.mode });
}

document.getElementById('btn-compare').addEventListener('click', compare);
el.mode.addEventListener('change', () => { if (state.ref1 && state.ref2) compare(); });
document.getElementById('btn-swap').addEventListener('click', () => {
  const a = el.ref1.value;
  el.ref1.value = el.ref2.value;
  el.ref2.value = a;
  if (state.ref1 && state.ref2) compare();
});

el.files.addEventListener('click', (e) => {
  const row = e.target.closest('.f-row');
  if (!row) return;
  vscode.postMessage({ command: 'openDiff', filePath: row.dataset.path, ref1: state.ref1, ref2: state.ref2 });
});

function renderCommits(commits, truncated) {
  if (!commits.length) {
    el.commits.innerHTML = '<div class="empty">No commits in this range.</div>';
    return;
  }
  el.commits.innerHTML = commits.map((c) =>
    '<div class="cm-row">'
      + '<div class="cm-subject">' + escHtml(c.subject) + '</div>'
      + '<div class="cm-meta">' + avatarHtml(c.author, c.authorEmail)
        + '<span>' + escHtml(c.author) + '</span>'
        + '<span>' + escHtml(relTime(c.authorDate)) + '</span>'
        + '<span class="cm-hash">' + escHtml(c.hash.slice(0, 7)) + '</span>'
      + '</div>'
    + '</div>').join('')
    + (truncated ? '<div class="fh-end">Showing the first ' + commits.length + ' commits.</div>' : '');
}

function renderFiles(files) {
  el.fileCount.textContent = files.length ? '(' + files.length + ')' : '';
  if (!files.length) {
    el.files.innerHTML = '<div class="empty">These refs have identical trees.</div>';
    return;
  }
  el.files.innerHTML = files.map((f) =>
    '<div class="f-row" data-path="' + escHtml(f.path) + '">'
      + '<span class="f-path" title="' + escHtml(f.path) + '">' + escHtml(f.path) + '</span>'
      + (f.oldPath ? '<span class="f-rename">renamed</span>' : '')
      + (f.binary
          ? '<span class="f-bin">binary</span>'
          : '<span class="f-stat"><span class="f-add">+' + f.additions + '</span> <span class="f-del">-' + f.deletions + '</span></span>')
    + '</div>').join('');
}

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.command) {
    case 'init': {
      state.refs = msg.data.refs;
      renderRefOptions();
      const t = msg.data.target || {};
      // Default to "what would I merge in": current branch on the right.
      if (t.ref1) el.ref1.value = t.ref1;
      else if (msg.data.current) {
        const main = state.refs.find((r) => r.kind === 'head' && (r.name === 'main' || r.name === 'master'));
        el.ref1.value = main && main.name !== msg.data.current ? main.name : el.ref1.value;
      }
      if (t.ref2) el.ref2.value = t.ref2;
      else if (msg.data.current) el.ref2.value = msg.data.current;
      if (el.ref1.value && el.ref2.value && el.ref1.value !== el.ref2.value) compare();
      else {
        el.commits.innerHTML = '<div class="empty">Pick two refs, then press Compare.</div>';
        el.files.innerHTML = '<div class="empty"></div>';
      }
      break;
    }
    case 'loading':
      clearError();
      el.commits.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
      el.files.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
      break;
    case 'loadCompare':
      clearError();
      state.ref1 = msg.data.ref1;
      state.ref2 = msg.data.ref2;
      el.counts.textContent = msg.data.counts.behind + ' behind · ' + msg.data.counts.ahead + ' ahead';
      renderCommits(msg.data.commits, msg.data.truncated);
      renderFiles(msg.data.files);
      break;
    case 'error':
      showError(msg.message);
      el.commits.innerHTML = '<div class="empty">' + escHtml(msg.message) + '</div>';
      el.files.innerHTML = '<div class="empty"></div>';
      break;
  }
});

vscode.postMessage({ command: 'ready' });
`,
  });
}
