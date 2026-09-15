/**
 * File history panel — the timeline of one file, with rename tracking, plus
 * line history for a chosen range.
 *
 * Whole-file mode uses `--follow` so the history survives renames; line mode
 * uses `-L<start>,<end>:<file>`, which follows the lines themselves. The two are
 * mutually exclusive in git (`-L` refuses `--follow`), hence the mode switch.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { VscodeApi } from "./git-exec.ts";
import { assertSafeFilePaths, assertValidHash, assertValidLineNumber, spawnGit } from "./git-exec.ts";
import { openPanel } from "./panel-registry.ts";
import { registerViewCommand } from "./register-view-command.ts";
import { navigateToPanel, takePendingTarget } from "./panel-nav.ts";
import { resolveProjectName } from "./ppm-api.ts";
import { FILE_HISTORY_FORMAT, buildLineRangeArg, parseFileHistory } from "./file-history-parser.ts";
import { FILE_PICKER_CSS, FILE_PICKER_HTML, FILE_PICKER_JS, shellHtml } from "./webview-shell.ts";

const VIEW_TYPE = "git-graph.fileHistory";
const PAGE_SIZE = 150;

export interface FileHistoryTarget {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
}

export function registerFileHistoryView(context: ExtensionContext, vscode: VscodeApi): void {
  registerViewCommand({
    context,
    vscode,
    command: VIEW_TYPE,
    label: "File History",
    open: (projectPath, args) => {
      const filePath = typeof args[1] === "string" ? args[1] : undefined;
      openFileHistoryView(vscode, context, projectPath, filePath ? { filePath } : undefined);
    },
  });
}

export function openFileHistoryView(
  vscode: VscodeApi,
  context: ExtensionContext,
  projectPath: string,
  target?: FileHistoryTarget,
): void {
  const dirName = projectPath.split(/[\\/]/).filter(Boolean).pop() || "History";
  const initialTarget = target ?? takePendingTarget<FileHistoryTarget>(VIEW_TYPE, projectPath);
  let fileList: string[] | null = null;

  const panel = openPanel({
    vscode,
    viewType: VIEW_TYPE,
    title: `History: ${dirName}`,
    projectPath,
    html: getFileHistoryHtml(),
    onMessage: async (raw) => {
      const msg = raw as Record<string, any>;
      try {
        switch (msg.command) {
          case "ready":
            await panel.webview.postMessage({ command: "init", data: { target: initialTarget ?? null } });
            if (initialTarget?.filePath) {
              await loadHistory(initialTarget.filePath, {
                lineStart: initialTarget.lineStart,
                lineEnd: initialTarget.lineEnd,
              });
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

          case "requestHistory":
            await loadHistory(String(msg.filePath || ""), {
              lineStart: msg.lineStart,
              lineEnd: msg.lineEnd,
              skip: msg.skip,
              append: Boolean(msg.append),
            });
            break;

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

          case "openBlame": {
            const filePath = String(msg.filePath || "");
            assertSafeFilePaths([filePath], projectPath);
            const fileName = filePath.split(/[\\/]/).pop() || filePath;
            await navigateToPanel({
              vscode,
              context,
              viewType: "git-graph.blame",
              title: `Blame: ${fileName}`,
              projectPath,
              target: { filePath, rev: msg.hash ? assertValidHash(msg.hash) : undefined },
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

  async function loadHistory(
    filePath: string,
    opts: { lineStart?: unknown; lineEnd?: unknown; skip?: unknown; append?: boolean },
  ): Promise<void> {
    if (!filePath) return;
    assertSafeFilePaths([filePath], projectPath);

    const hasRange = opts.lineStart != null && opts.lineEnd != null;
    const skip = Number(opts.skip) > 0 ? Number(opts.skip) : 0;

    const args = ["log", `--format=${FILE_HISTORY_FORMAT}`, `--max-count=${PAGE_SIZE}`];
    if (skip > 0) args.push(`--skip=${skip}`);

    let lineStart: number | undefined;
    let lineEnd: number | undefined;
    if (hasRange) {
      lineStart = assertValidLineNumber(opts.lineStart, "lineStart");
      lineEnd = assertValidLineNumber(opts.lineEnd, "lineEnd");
      // `-s` suppresses the patch that -L emits by default; we only want commits.
      args.push("-s", buildLineRangeArg(lineStart, lineEnd, filePath));
    } else {
      args.push("--follow", "--name-status", "--", filePath);
    }

    if (!opts.append) await panel.webview.postMessage({ command: "loading" });
    const res = await spawnGit(vscode, args, projectPath, 60_000);
    if (res.exitCode !== 0) {
      const detail = res.stderr.trim() || `git log exited with ${res.exitCode}`;
      await panel.webview.postMessage({ command: "error", message: detail });
      return;
    }

    const entries = parseFileHistory(res.stdout);
    await panel.webview.postMessage({
      command: "loadHistory",
      data: {
        filePath,
        lineStart: lineStart ?? null,
        lineEnd: lineEnd ?? null,
        entries,
        skip,
        append: Boolean(opts.append),
        hasMore: entries.length === PAGE_SIZE,
      },
    });
  }
}

function getFileHistoryHtml(): string {
  return shellHtml({
    toolbar: `
      <div class="toolbar-left">
        <button id="btn-pick" title="Choose a file">Open file…</button>
        <span class="toolbar-title" id="file-label">No file</span>
      </div>
      <div class="toolbar-right">
        <label class="range-label"><input type="checkbox" id="chk-lines" /> Lines</label>
        <input type="text" id="line-start" class="line-input hidden" placeholder="from" inputmode="numeric" />
        <input type="text" id="line-end" class="line-input hidden" placeholder="to" inputmode="numeric" />
        <button id="btn-apply-lines" class="hidden">Apply</button>
        <button id="btn-blame" title="Blame this file" disabled>Blame</button>
        <button id="btn-refresh" disabled>Reload</button>
      </div>`,
    body: `${FILE_PICKER_HTML}
      <div id="list" class="scroll"></div>`,
    css: `${FILE_PICKER_CSS}
.range-label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--subtext); white-space: nowrap; }
.line-input { width: 58px; }

.fh-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.fh-row:hover { background: var(--surface-hover); }
.fh-main { flex: 1; min-width: 0; }
.fh-subject { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fh-meta { color: var(--subtext); font-size: 10px; margin-top: 2px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.fh-hash { font-family: ui-monospace, monospace; }
.fh-status { font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; border: 1px solid var(--border2); }
.fh-status.A { color: var(--green); border-color: var(--green); }
.fh-status.M { color: var(--blue); border-color: var(--blue); }
.fh-status.D { color: var(--red); border-color: var(--red); }
.fh-status.R, .fh-status.C { color: var(--purple); border-color: var(--purple); }
.fh-rename { color: var(--purple); font-size: 10px; }
.fh-actions { display: flex; gap: 4px; flex-shrink: 0; }
.fh-more { padding: 10px; text-align: center; }
.fh-end { padding: 10px; text-align: center; color: var(--subtext); font-size: 10px; }`,
    script: `
const state = { filePath: null, lineStart: null, lineEnd: null, entries: [], hasMore: false, loading: false };

const el = {
  list: document.getElementById('list'),
  fileLabel: document.getElementById('file-label'),
  chkLines: document.getElementById('chk-lines'),
  lineStart: document.getElementById('line-start'),
  lineEnd: document.getElementById('line-end'),
  btnApplyLines: document.getElementById('btn-apply-lines'),
  btnBlame: document.getElementById('btn-blame'),
  btnRefresh: document.getElementById('btn-refresh'),
};

/* --- File picker (shared) --- */
${FILE_PICKER_JS}

function onFileChosen(filePath) {
  state.lineStart = null;
  state.lineEnd = null;
  el.chkLines.checked = false;
  syncLineInputs();
  request(filePath, false);
}

document.getElementById('btn-pick').addEventListener('click', () => {
  if (isFilePickerOpen()) closeFilePicker(); else openFilePicker();
});

function syncLineInputs() {
  const on = el.chkLines.checked;
  for (const node of [el.lineStart, el.lineEnd, el.btnApplyLines]) node.classList.toggle('hidden', !on);
}

el.chkLines.addEventListener('change', () => {
  syncLineInputs();
  if (!el.chkLines.checked && state.filePath) {
    state.lineStart = null;
    state.lineEnd = null;
    request(state.filePath, false);
  }
});

el.btnApplyLines.addEventListener('click', () => {
  if (!state.filePath) return;
  const a = parseInt(el.lineStart.value, 10);
  const b = parseInt(el.lineEnd.value, 10);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) {
    showError('Enter two line numbers of 1 or more.');
    return;
  }
  state.lineStart = a;
  state.lineEnd = b;
  request(state.filePath, false);
});

function request(filePath, append) {
  if (state.loading) return;
  state.loading = true;
  vscode.postMessage({
    command: 'requestHistory',
    filePath,
    append,
    skip: append ? state.entries.length : 0,
    lineStart: state.lineStart ?? undefined,
    lineEnd: state.lineEnd ?? undefined,
  });
}

el.btnRefresh.addEventListener('click', () => { if (state.filePath) request(state.filePath, false); });
el.btnBlame.addEventListener('click', () => {
  if (state.filePath) vscode.postMessage({ command: 'openBlame', filePath: state.filePath });
});

function render() {
  if (!state.filePath) {
    el.list.innerHTML = '<div class="empty">Choose a file to see every commit that touched it.</div>';
    return;
  }
  if (!state.entries.length) {
    el.list.innerHTML = '<div class="empty">No commits found for this file' + (state.lineStart ? ' in lines ' + state.lineStart + '–' + state.lineEnd : '') + '.</div>';
    return;
  }
  let html = '';
  for (const e of state.entries) {
    html += '<div class="fh-row" data-hash="' + escHtml(e.hash) + '" data-path="' + escHtml(e.path || state.filePath) + '">'
      + '<div class="fh-main">'
        + '<div class="fh-subject">' + escHtml(e.subject) + '</div>'
        + '<div class="fh-meta">'
          + avatarHtml(e.author, e.authorEmail)
          + '<span>' + escHtml(e.author) + '</span>'
          + '<span>' + escHtml(relTime(e.authorDate)) + '</span>'
          + '<span class="fh-hash">' + escHtml(e.hash.slice(0, 7)) + '</span>'
          + (e.status ? '<span class="fh-status ' + escHtml(e.status) + '">' + escHtml(e.status) + '</span>' : '')
          + (e.oldPath ? '<span class="fh-rename">renamed from ' + escHtml(e.oldPath) + '</span>' : '')
        + '</div>'
      + '</div>'
      + '<div class="fh-actions">'
        + '<button data-act="blame" title="Blame at this commit">Blame</button>'
      + '</div>'
    + '</div>';
  }
  html += state.hasMore
    ? '<div class="fh-more"><button id="btn-more">Load more</button></div>'
    : '<div class="fh-end">End of history</div>';
  el.list.innerHTML = html;
  const more = document.getElementById('btn-more');
  if (more) more.addEventListener('click', () => request(state.filePath, true));
}

el.list.addEventListener('click', (e) => {
  const row = e.target.closest('.fh-row');
  if (!row) return;
  const act = e.target.closest('button[data-act]');
  if (act && act.dataset.act === 'blame') {
    vscode.postMessage({ command: 'openBlame', filePath: row.dataset.path, hash: row.dataset.hash });
    return;
  }
  vscode.postMessage({ command: 'openDiff', filePath: row.dataset.path, hash: row.dataset.hash });
});

window.addEventListener('message', (event) => {
  const msg = event.data || {};
  switch (msg.command) {
    case 'init':
      if (!msg.data.target) { render(); openFilePicker(); }
      break;
    case 'loading':
      clearError();
      el.list.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
      break;
    case 'loadFiles':
      applyFileList(msg.data);
      break;
    case 'loadHistory':
      clearError();
      state.loading = false;
      state.filePath = msg.data.filePath;
      state.lineStart = msg.data.lineStart;
      state.lineEnd = msg.data.lineEnd;
      state.entries = msg.data.append ? state.entries.concat(msg.data.entries) : msg.data.entries;
      state.hasMore = msg.data.hasMore;
      el.fileLabel.textContent = state.filePath + (state.lineStart ? ' :' + state.lineStart + '–' + state.lineEnd : '');
      el.btnBlame.disabled = false;
      el.btnRefresh.disabled = false;
      if (state.lineStart) {
        el.chkLines.checked = true;
        el.lineStart.value = state.lineStart;
        el.lineEnd.value = state.lineEnd;
        syncLineInputs();
      }
      render();
      break;
    case 'error':
      state.loading = false;
      showError(msg.message);
      if (!state.entries.length) el.list.innerHTML = '<div class="empty">' + escHtml(msg.message) + '</div>';
      break;
  }
});

render();
vscode.postMessage({ command: 'ready' });
`,
  });
}
