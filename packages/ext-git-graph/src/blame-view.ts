/**
 * Blame panel — per-line authorship for one file.
 *
 * This is a panel rather than editor gutter annotations because PPM's extension
 * API exposes no editor: there is no `activeTextEditor`, no `setDecorations`,
 * and `vscode.languages` throws. So the panel renders its own read-only code
 * view (plain monospace — syntax highlighting would need the editor's tokenizer)
 * with the blame gutter beside it.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { VscodeApi } from "./git-exec.ts";
import { assertSafeFilePaths, assertValidHash, assertValidLineNumber, spawnGit } from "./git-exec.ts";
import { openPanel } from "./panel-registry.ts";
import { registerViewCommand } from "./register-view-command.ts";
import { navigateToPanel, takePendingTarget } from "./panel-nav.ts";
import { resolveProjectName } from "./ppm-api.ts";
import { computeAgeWeights, isUncommittedHash, parseBlamePorcelain } from "./blame-parser.ts";
import { FILE_PICKER_CSS, FILE_PICKER_HTML, FILE_PICKER_JS, shellHtml } from "./webview-shell.ts";

const VIEW_TYPE = "git-graph.blame";

export interface BlameTarget {
  filePath: string;
  /** Scroll to and highlight this 1-based line once loaded. */
  line?: number;
  /** Blame the file as of this commit instead of the working tree. */
  rev?: string;
}

export function registerBlameView(context: ExtensionContext, vscode: VscodeApi): void {
  registerViewCommand({
    context,
    vscode,
    command: VIEW_TYPE,
    label: "Git Blame",
    open: (projectPath, args) => {
      // args[1] lets the graph's file tree open blame straight onto a file.
      const filePath = typeof args[1] === "string" ? args[1] : undefined;
      openBlameView(vscode, context, projectPath, filePath ? { filePath } : undefined);
    },
  });
}

export function openBlameView(
  vscode: VscodeApi,
  context: ExtensionContext,
  projectPath: string,
  target?: BlameTarget,
): void {
  const dirName = projectPath.split(/[\\/]/).filter(Boolean).pop() || "Blame";
  const initialTarget = target ?? takePendingTarget<BlameTarget>(VIEW_TYPE, projectPath);

  // Full tracked-file list, fetched once and filtered here so the webview never
  // has to hold a huge repo's worth of paths.
  let fileList: string[] | null = null;

  const panel = openPanel({
    vscode,
    viewType: VIEW_TYPE,
    title: `Blame: ${dirName}`,
    projectPath,
    html: getBlameHtml(),
    onMessage: async (raw) => {
      const msg = raw as Record<string, any>;
      try {
        switch (msg.command) {
          case "ready":
            await panel.webview.postMessage({ command: "init", data: { target: initialTarget ?? null } });
            if (initialTarget?.filePath) {
              await loadBlame(initialTarget.filePath, initialTarget.rev, initialTarget.line);
            }
            break;

          case "requestFiles": {
            if (!fileList) {
              const res = await spawnGit(vscode, ["ls-files", "-z"], projectPath, 60_000);
              fileList = res.stdout.split("\0").filter(Boolean);
            }
            const query = String(msg.query || "").toLowerCase();
            const matches = (query
              ? fileList.filter((f) => f.toLowerCase().includes(query))
              : fileList
            ).slice(0, 300);
            await panel.webview.postMessage({
              command: "loadFiles",
              data: { files: matches, total: fileList.length },
            });
            break;
          }

          case "requestBlame":
            await loadBlame(String(msg.filePath || ""), msg.rev ? String(msg.rev) : undefined, msg.line);
            break;

          case "blamePrevious": {
            // Resolve `<hash>^` here rather than passing a caret into git args —
            // assertValidHash deliberately rejects revision expressions.
            const hash = assertValidHash(msg.hash);
            const filePath = String(msg.filePath || "");
            assertSafeFilePaths([filePath], projectPath);
            const parent = await spawnGit(vscode, ["rev-parse", `${hash}^`], projectPath);
            if (parent.exitCode !== 0) {
              await panel.webview.postMessage({ command: "error", message: "This is the first commit for this file." });
              break;
            }
            await loadBlame(filePath, parent.stdout.trim(), undefined);
            break;
          }

          case "openDiff": {
            const filePath = String(msg.filePath || "");
            assertSafeFilePaths([filePath], projectPath);
            const hash = assertValidHash(msg.hash);
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            const projectName = await resolveProjectName(projectPath);
            const parent = await spawnGit(vscode, ["rev-parse", `${hash}^`], projectPath);
            await vscode.window.openTab("git-diff", `${fileName} (${hash.slice(0, 7)})`, projectName, {
              projectName,
              filePath,
              ...(parent.exitCode === 0 ? { ref1: parent.stdout.trim() } : {}),
              ref2: hash,
            });
            break;
          }

          case "openLineHistory": {
            const filePath = String(msg.filePath || "");
            assertSafeFilePaths([filePath], projectPath);
            const line = assertValidLineNumber(msg.line, "line");
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            await navigateToPanel({
              vscode,
              context,
              viewType: "git-graph.fileHistory",
              title: `History: ${fileName}:${line}`,
              projectPath,
              // A single line is a one-line range; the panel widens it from there.
              target: { filePath, lineStart: line, lineEnd: line },
            });
            break;
          }

          case "openHistory": {
            const filePath = String(msg.filePath || "");
            assertSafeFilePaths([filePath], projectPath);
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            await navigateToPanel({
              vscode,
              context,
              viewType: "git-graph.fileHistory",
              title: `History: ${fileName}`,
              projectPath,
              target: { filePath },
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

  async function loadBlame(filePath: string, rev?: string, line?: unknown): Promise<void> {
    if (!filePath) return;
    assertSafeFilePaths([filePath], projectPath);
    const args = ["blame", "--porcelain"];
    if (rev) args.push(assertValidHash(rev));
    args.push("--", filePath);

    await panel.webview.postMessage({ command: "loading", data: { filePath } });
    const res = await spawnGit(vscode, args, projectPath, 60_000);
    if (res.exitCode !== 0) {
      const detail = res.stderr.trim() || `git blame exited with ${res.exitCode}`;
      await panel.webview.postMessage({ command: "error", message: detail });
      return;
    }

    const parsed = parseBlamePorcelain(res.stdout);
    await panel.webview.postMessage({
      command: "loadBlame",
      data: {
        filePath,
        rev: rev ?? null,
        lines: parsed.lines,
        commits: parsed.commits,
        weights: computeAgeWeights(parsed.commits),
        uncommitted: Object.keys(parsed.commits).filter(isUncommittedHash),
        focusLine: typeof line === "number" ? line : null,
      },
    });
  }
}

function getBlameHtml(): string {
  return shellHtml({
    toolbar: `
      <div class="toolbar-left">
        <button id="btn-pick" title="Choose a file">Open file…</button>
        <span class="toolbar-title" id="file-label">No file</span>
        <span class="toolbar-sub" id="rev-label"></span>
      </div>
      <div class="toolbar-right">
        <button id="btn-history" title="File history" disabled>History</button>
        <button id="btn-refresh" title="Reload blame" disabled>Reload</button>
      </div>`,
    body: `${FILE_PICKER_HTML}
      <div id="blame" class="scroll"></div>
      <div id="detail" class="detail hidden"></div>`,
    css: `${FILE_PICKER_CSS}
#blame { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.bl-row { display: grid; grid-template-columns: 4px 190px 52px 1fr; align-items: stretch; border-bottom: 1px solid transparent; }
.bl-row:hover { background: var(--surface-hover); }
.bl-row.focus { background: var(--selected); }
.bl-heat { width: 4px; }
.bl-gutter { display: flex; align-items: center; gap: 5px; padding: 1px 6px; border-right: 1px solid var(--border); color: var(--subtext); font-size: 10px; cursor: pointer; overflow: hidden; white-space: nowrap; min-width: 0; }
.bl-gutter.repeat { color: transparent; }
.bl-gutter.repeat .avatar { visibility: hidden; }
.bl-row:hover .bl-gutter.repeat { color: var(--subtle); }
.bl-gutter .bl-author { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.bl-gutter .bl-hash { font-variant-numeric: tabular-nums; }
.bl-uncommitted .bl-gutter { color: var(--yellow); font-style: italic; }
.bl-lineno { text-align: right; padding: 1px 8px 1px 4px; color: var(--subtle); border-right: 1px solid var(--border); font-variant-numeric: tabular-nums; user-select: none; }
.bl-code { padding: 1px 8px; white-space: pre; overflow-x: visible; }

.detail { border-top: 1px solid var(--border2); background: var(--surface); padding: 8px 12px; flex-shrink: 0; max-height: 34vh; overflow: auto; }
.detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.detail-subject { font-weight: 600; font-size: 12px; }
.detail-meta { color: var(--subtext); font-size: 11px; margin-bottom: 6px; }
.detail-actions { display: flex; gap: 6px; flex-wrap: wrap; }

@media (max-width: 640px) {
  .bl-row { grid-template-columns: 4px 118px 40px 1fr; }
  .bl-gutter .bl-hash { display: none; }
}`,
    script: `
const state = { filePath: null, rev: null, lines: [], commits: {}, weights: {}, selected: null, selectedLine: null };

const el = {
  blame: document.getElementById('blame'),
  fileLabel: document.getElementById('file-label'),
  revLabel: document.getElementById('rev-label'),
  detail: document.getElementById('detail'),
  btnHistory: document.getElementById('btn-history'),
  btnRefresh: document.getElementById('btn-refresh'),
};

/* Heatmap: newest commits run warm (orange), oldest run cool (blue). */
function heatColor(w) {
  const stops = [[59,130,246],[20,184,166],[234,179,8],[249,115,22],[239,68,68]];
  const x = Math.max(0, Math.min(1, Number(w) || 0)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return 'rgb(' + c.join(',') + ')';
}

function render() {
  if (!state.filePath) {
    el.blame.innerHTML = '<div class="empty">Choose a file to see who last touched each line.</div>';
    return;
  }
  if (!state.lines.length) {
    el.blame.innerHTML = '<div class="empty">This file has no lines to blame.</div>';
    return;
  }
  let html = '';
  let prevHash = null;
  for (const line of state.lines) {
    const info = state.commits[line.hash] || {};
    const uncommitted = /^0+$/.test(line.hash);
    const repeat = line.hash === prevHash;
    prevHash = line.hash;
    html += '<div class="bl-row' + (uncommitted ? ' bl-uncommitted' : '') + '" data-line="' + line.finalLine + '" data-hash="' + escHtml(line.hash) + '">'
      + '<div class="bl-heat" style="background:' + (uncommitted ? 'var(--yellow)' : heatColor(state.weights[line.hash])) + '"></div>'
      + '<div class="bl-gutter' + (repeat ? ' repeat' : '') + '">'
        + (uncommitted ? '' : avatarHtml(info.author, info.authorMail))
        + '<span class="bl-author">' + escHtml(uncommitted ? 'Uncommitted' : (info.author || '?')) + '</span>'
        + '<span class="bl-hash">' + escHtml(uncommitted ? '' : line.hash.slice(0, 7)) + '</span>'
      + '</div>'
      + '<div class="bl-lineno">' + line.finalLine + '</div>'
      + '<div class="bl-code">' + escHtml(line.content || ' ') + '</div>'
      + '</div>';
  }
  el.blame.innerHTML = html;
}

function showDetail(hash, line) {
  const info = state.commits[hash];
  if (!info || /^0+$/.test(hash)) { el.detail.classList.add('hidden'); return; }
  state.selected = hash;
  state.selectedLine = Number(line) || null;
  el.detail.classList.remove('hidden');
  el.detail.innerHTML = '<div class="detail-head">' + avatarHtml(info.author, info.authorMail)
    + '<span class="detail-subject">' + escHtml(info.summary || '(no subject)') + '</span></div>'
    + '<div class="detail-meta">' + escHtml(info.author || '?') + ' &lt;' + escHtml(info.authorMail || '') + '&gt; · '
    + escHtml(relTime(info.authorTime)) + ' · <code>' + escHtml(hash.slice(0, 10)) + '</code>'
    + (info.filename && info.filename !== state.filePath ? ' · was <code>' + escHtml(info.filename) + '</code>' : '')
    + '</div>'
    + '<div class="detail-actions">'
      + '<button data-act="diff">Open this commit\\'s diff</button>'
      + '<button data-act="prev">Blame before this commit</button>'
      + (state.selectedLine ? '<button data-act="lineHistory">History of line ' + state.selectedLine + '</button>' : '')
      + '<button data-act="close">Close</button>'
    + '</div>';
}

el.blame.addEventListener('click', (e) => {
  const gutter = e.target.closest('.bl-gutter');
  if (!gutter) return;
  const row = gutter.closest('.bl-row');
  if (row) showDetail(row.dataset.hash, row.dataset.line);
});

el.detail.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'close') { el.detail.classList.add('hidden'); return; }
  if (act === 'diff') vscode.postMessage({ command: 'openDiff', filePath: state.filePath, hash: state.selected });
  if (act === 'prev') vscode.postMessage({ command: 'blamePrevious', filePath: state.filePath, hash: state.selected });
  if (act === 'lineHistory') vscode.postMessage({ command: 'openLineHistory', filePath: state.filePath, line: state.selectedLine });
});

/* --- File picker (shared) --- */
${FILE_PICKER_JS}

function onFileChosen(filePath) {
  vscode.postMessage({ command: 'requestBlame', filePath });
}

document.getElementById('btn-pick').addEventListener('click', () => {
  if (isFilePickerOpen()) closeFilePicker(); else openFilePicker();
});

el.btnRefresh.addEventListener('click', () => {
  if (state.filePath) vscode.postMessage({ command: 'requestBlame', filePath: state.filePath, rev: state.rev || undefined });
});
el.btnHistory.addEventListener('click', () => {
  if (state.filePath) vscode.postMessage({ command: 'openHistory', filePath: state.filePath });
});

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.command) {
    case 'init':
      if (!msg.data.target) { render(); openFilePicker(); }
      break;
    case 'loading':
      clearError();
      el.blame.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
      break;
    case 'loadFiles':
      applyFileList(msg.data);
      break;
    case 'loadBlame': {
      clearError();
      state.filePath = msg.data.filePath;
      state.rev = msg.data.rev;
      state.lines = msg.data.lines;
      state.commits = msg.data.commits;
      state.weights = msg.data.weights;
      el.fileLabel.textContent = state.filePath;
      el.revLabel.textContent = state.rev ? 'at ' + state.rev.slice(0, 7) : '';
      el.btnHistory.disabled = false;
      el.btnRefresh.disabled = false;
      el.detail.classList.add('hidden');
      render();
      if (msg.data.focusLine) {
        const row = el.blame.querySelector('.bl-row[data-line="' + msg.data.focusLine + '"]');
        if (row) { row.classList.add('focus'); row.scrollIntoView({ block: 'center' }); }
      }
      break;
    }
    case 'error':
      showError(msg.message);
      if (!state.lines.length) el.blame.innerHTML = '<div class="empty">' + escHtml(msg.message) + '</div>';
      break;
  }
});

render();
vscode.postMessage({ command: 'ready' });
`,
  });
}
