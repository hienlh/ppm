/**
 * Full-featured table viewer webview panel.
 * Replicates ~90% of the built-in DatabaseViewer:
 * - Toolbar with connection/table name, refresh, SQL toggle
 * - Data grid with sticky headers, inline cell editing (double-click)
 * - Pagination (prev/next, page X / total)
 * - Toggleable SQL query panel with execute (Cmd+Enter)
 * - NULL styling, row hover, loading states
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface TableViewerOptions {
  connectionId: number;
  connectionName: string;
  tableName: string;
  schemaName: string;
}

export function getTableViewerHtml(opts: TableViewerOptions): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #ffffff; --surface: #f4f4f5; --mantle: #fafafa;
    --overlay0: #71717a; --overlay1: #52525b;
    --text: #09090b; --subtext: #71717a; --subtle: #a1a1aa;
    --border: #e4e4e7; --border2: #d4d4d8;
    --blue: #3b82f6; --green: #22c55e; --red: #ef4444; --yellow: #eab308;
    --surface-hover: #f4f4f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #09090b; --surface: #18181b; --mantle: #09090b;
      --overlay0: #71717a; --overlay1: #a1a1aa;
      --text: #fafafa; --subtext: #a1a1aa; --subtle: #52525b;
      --border: #27272a; --border2: #3f3f46;
      --blue: #3b82f6; --green: #22c55e; --red: #ef4444; --yellow: #eab308;
      --surface-hover: #27272a;
    }
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); font-size: 13px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

  /* Toolbar */
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--bg); flex-shrink: 0; }
  .toolbar .icon { width: 14px; height: 14px; color: var(--overlay0); }
  .toolbar .conn-name { font-size: 12px; color: var(--subtext); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toolbar .separator { color: var(--subtle); font-size: 12px; }
  .toolbar .table-name { font-size: 12px; color: var(--subtext); }
  .toolbar .spacer { flex: 1; }
  .toolbar button { background: none; border: none; cursor: pointer; padding: 4px; border-radius: 4px; color: var(--subtext); transition: color 0.15s, background 0.15s; display: flex; align-items: center; justify-content: center; }
  .toolbar button:hover { color: var(--text); background: var(--surface-hover); }
  .toolbar button.active { background: var(--border); color: var(--text); }
  .toolbar .btn-text { font-size: 12px; padding: 4px 8px; font-weight: 500; }

  /* Grid container */
  .grid-container { flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
  .grid-scroll { flex: 1; overflow: auto; min-height: 0; }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: auto; }
  thead { position: sticky; top: 0; z-index: 10; }
  th { background: var(--border); text-align: left; padding: 6px 8px; font-weight: 600; font-size: 11px; color: var(--subtext); white-space: nowrap; border-bottom: 1px solid var(--border2); }
  th.pk { font-weight: 700; color: var(--yellow); }
  td { padding: 4px 8px; border-bottom: 1px solid var(--border); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }
  tr:hover td { background: var(--surface-hover); }
  td.null-val { color: var(--subtle); font-style: italic; }
  td.editing { padding: 2px 4px; }
  td.editing input { width: 100%; background: transparent; border: 1px solid var(--blue); border-radius: 3px; color: var(--text); padding: 2px 4px; font-size: 12px; font-family: inherit; outline: none; }

  /* Pagination */
  .pagination { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; border-top: 1px solid var(--border); background: var(--bg); flex-shrink: 0; font-size: 12px; color: var(--subtext); }
  .pagination .page-controls { display: flex; align-items: center; gap: 8px; }
  .pagination button { background: none; border: none; cursor: pointer; padding: 2px; border-radius: 3px; color: var(--subtext); display: flex; align-items: center; }
  .pagination button:hover:not(:disabled) { color: var(--text); background: var(--surface-hover); }
  .pagination button:disabled { opacity: 0.3; cursor: default; }

  /* SQL panel */
  .sql-panel { border-top: 1px solid var(--border); display: flex; flex-direction: column; height: 40%; flex-shrink: 0; overflow: hidden; }
  .sql-panel.hidden { display: none; }
  .sql-header { display: flex; align-items: flex-start; gap: 4px; border-bottom: 1px solid var(--border); background: var(--bg); }
  .sql-header textarea { flex: 1; background: transparent; border: none; color: var(--text); padding: 8px; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12px; resize: none; outline: none; max-height: 120px; min-height: 60px; }
  .sql-header button { margin: 4px; padding: 6px; border-radius: 4px; background: var(--blue); color: var(--mantle); border: none; cursor: pointer; font-weight: 600; font-size: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .sql-header button:hover { opacity: 0.9; }
  .sql-header button:disabled { opacity: 0.5; }
  .sql-results { flex: 1; overflow: auto; font-size: 12px; min-height: 0; }
  .sql-results .sql-error { padding: 8px 12px; color: var(--red); background: rgba(243,139,168,0.05); }
  .sql-results .sql-modify { padding: 8px 12px; color: var(--green); }
  .sql-results .sql-empty { padding: 8px 12px; color: var(--subtext); }
  .sql-results table th { background: var(--border); }

  /* Loading / empty states */
  .state-msg { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--overlay0); font-size: 12px; gap: 8px; }
  .spinner { width: 16px; height: 16px; border: 2px solid var(--border2); border-top-color: var(--blue); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .refresh-spin { animation: spin 0.6s linear infinite; }

  /* SVG icons inline */
  svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style>
</head>
<body>
  <!-- Toolbar -->
  <div class="toolbar">
    <svg class="icon" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>
    <span class="conn-name">${esc(opts.connectionName)}</span>
    <span class="separator">/</span>
    <span class="table-name">${esc(opts.tableName)}</span>
    <span class="spacer"></span>
    <button id="btn-refresh" title="Refresh data">
      <svg id="refresh-icon" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
    </button>
    <button id="btn-sql" class="btn-text" title="Toggle SQL query panel">SQL</button>
  </div>

  <!-- Data grid -->
  <div class="grid-container" id="grid-container">
    <div class="grid-scroll" id="grid-scroll">
      <div class="state-msg" id="loading-msg"><div class="spinner"></div> Loading…</div>
    </div>
  </div>

  <!-- Pagination -->
  <div class="pagination" id="pagination" style="display:none">
    <span id="row-count">0 rows</span>
    <div class="page-controls">
      <button id="btn-prev" disabled>
        <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <span id="page-info">1 / 1</span>
      <button id="btn-next" disabled>
        <svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>
  </div>

  <!-- SQL panel -->
  <div class="sql-panel hidden" id="sql-panel">
    <div class="sql-header">
      <textarea id="sql-input" placeholder="Enter SQL query… (Cmd+Enter to execute)" rows="3">SELECT * FROM ${esc(opts.schemaName !== "main" && opts.schemaName !== "public" ? opts.schemaName + "." : "")}${esc(opts.tableName)} LIMIT 100;</textarea>
      <button id="btn-run-sql" title="Execute (Cmd+Enter)">
        <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </button>
    </div>
    <div class="sql-results" id="sql-results"></div>
  </div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const connId = ${opts.connectionId};
  const tableName = "${esc(opts.tableName).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";
  const schemaName = "${esc(opts.schemaName).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";

  // State
  let currentPage = 1;
  let totalRows = 0;
  let pageLimit = 100;
  let columns = [];
  let rows = [];
  let schema = []; // { name, type, nullable, pk, defaultValue }
  let pkCol = null;
  let editingCell = null; // { rowIdx, col }
  let loading = true;
  let sqlPanelOpen = false;

  // Elements
  const gridScroll = document.getElementById('grid-scroll');
  const gridContainer = document.getElementById('grid-container');
  const pagination = document.getElementById('pagination');
  const rowCountEl = document.getElementById('row-count');
  const pageInfoEl = document.getElementById('page-info');
  const btnPrev = document.getElementById('btn-prev');
  const btnNext = document.getElementById('btn-next');
  const btnRefresh = document.getElementById('btn-refresh');
  const refreshIcon = document.getElementById('refresh-icon');
  const btnSql = document.getElementById('btn-sql');
  const sqlPanel = document.getElementById('sql-panel');
  const sqlInput = document.getElementById('sql-input');
  const sqlResults = document.getElementById('sql-results');
  const btnRunSql = document.getElementById('btn-run-sql');

  // -- Request initial data --
  vscode.postMessage({ type: 'init', connectionId: connId, tableName, schemaName });

  // -- Toolbar actions --
  btnRefresh.addEventListener('click', () => {
    loading = true;
    refreshIcon.classList.add('refresh-spin');
    vscode.postMessage({ type: 'refresh' });
  });

  btnSql.addEventListener('click', () => {
    sqlPanelOpen = !sqlPanelOpen;
    sqlPanel.classList.toggle('hidden', !sqlPanelOpen);
    btnSql.classList.toggle('active', sqlPanelOpen);
    if (sqlPanelOpen) {
      gridContainer.style.maxHeight = '60%';
    } else {
      gridContainer.style.maxHeight = '';
    }
  });

  // -- Pagination --
  btnPrev.addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; fetchPage(); }
  });
  btnNext.addEventListener('click', () => {
    const totalPages = Math.ceil(totalRows / pageLimit) || 1;
    if (currentPage < totalPages) { currentPage++; fetchPage(); }
  });

  function fetchPage() {
    loading = true;
    renderGrid();
    vscode.postMessage({ type: 'fetchPage', page: currentPage });
  }

  // -- SQL --
  btnRunSql.addEventListener('click', runSql);
  sqlInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      runSql();
    }
  });

  function runSql() {
    const sql = sqlInput.value.trim();
    if (!sql) return;
    btnRunSql.disabled = true;
    sqlResults.innerHTML = '<div class="state-msg"><div class="spinner"></div></div>';
    vscode.postMessage({ type: 'executeQuery', sql });
  }

  // -- Render data grid --
  function renderGrid() {
    if (loading && rows.length === 0) {
      gridScroll.innerHTML = '<div class="state-msg"><div class="spinner"></div> Loading…</div>';
      pagination.style.display = 'none';
      return;
    }
    if (!columns.length) {
      gridScroll.innerHTML = '<div class="state-msg">No data</div>';
      pagination.style.display = 'none';
      return;
    }

    let html = '<table><thead><tr>';
    columns.forEach(col => {
      const info = schema.find(s => s.name === col);
      const isPk = info && info.pk;
      html += '<th' + (isPk ? ' class="pk"' : '') + '>' + escH(col) + '</th>';
    });
    html += '</tr></thead><tbody>';

    if (rows.length === 0) {
      html += '<tr><td colspan="' + columns.length + '" style="text-align:center;padding:32px;color:var(--overlay0)">No data</td></tr>';
    } else {
      rows.forEach((row, rowIdx) => {
        html += '<tr>';
        columns.forEach(col => {
          const val = row[col];
          const isEditing = editingCell && editingCell.rowIdx === rowIdx && editingCell.col === col;
          if (isEditing) {
            const editVal = val == null ? '' : String(val);
            html += '<td class="editing"><input data-row="' + rowIdx + '" data-col="' + escH(col) + '" value="' + escH(editVal) + '" /></td>';
          } else if (val == null) {
            html += '<td class="null-val" data-row="' + rowIdx + '" data-col="' + escH(col) + '">NULL</td>';
          } else {
            html += '<td data-row="' + rowIdx + '" data-col="' + escH(col) + '" title="' + escH(String(val)) + '">' + escH(String(val)) + '</td>';
          }
        });
        html += '</tr>';
      });
    }
    html += '</tbody></table>';
    gridScroll.innerHTML = html;

    // Attach edit handlers
    if (pkCol) {
      gridScroll.querySelectorAll('td:not(.editing)').forEach(td => {
        td.addEventListener('dblclick', () => {
          const r = parseInt(td.getAttribute('data-row'));
          const c = td.getAttribute('data-col');
          if (isNaN(r) || !c) return;
          editingCell = { rowIdx: r, col: c };
          renderGrid();
          // Focus the input
          setTimeout(() => {
            const inp = gridScroll.querySelector('input[data-row="' + r + '"][data-col="' + c + '"]');
            if (inp) { inp.focus(); inp.select(); }
          }, 10);
        });
      });
    }

    // Edit input handlers
    gridScroll.querySelectorAll('td.editing input').forEach(inp => {
      inp.addEventListener('blur', () => commitEdit(inp));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitEdit(inp); }
        if (e.key === 'Escape') { editingCell = null; renderGrid(); }
      });
    });

    // Update pagination
    const totalPages = Math.ceil(totalRows / pageLimit) || 1;
    pagination.style.display = 'flex';
    rowCountEl.textContent = totalRows.toLocaleString() + ' rows';
    pageInfoEl.textContent = currentPage + ' / ' + totalPages;
    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= totalPages;
    refreshIcon.classList.remove('refresh-spin');
  }

  function commitEdit(inp) {
    if (!editingCell || !pkCol) return;
    const rowIdx = editingCell.rowIdx;
    const col = editingCell.col;
    const newVal = inp.value;
    const row = rows[rowIdx];
    if (!row) { editingCell = null; renderGrid(); return; }
    const oldVal = row[col];
    editingCell = null;
    if (String(oldVal ?? '') !== newVal) {
      vscode.postMessage({
        type: 'updateCell',
        pkColumn: pkCol,
        pkValue: row[pkCol],
        column: col,
        value: newVal === '' ? null : newVal,
      });
    }
    renderGrid();
  }

  // -- Render SQL results --
  function renderSqlResult(msg) {
    btnRunSql.disabled = false;
    if (msg.type === 'queryError') {
      sqlResults.innerHTML = '<div class="sql-error">' + escH(msg.error) + '</div>';
      return;
    }
    if (msg.changeType === 'modify') {
      sqlResults.innerHTML = '<div class="sql-modify">Query executed. ' + (msg.rowsAffected ?? 0) + ' row(s) affected.' + (msg.duration ? ' (' + msg.duration + 'ms)' : '') + '</div>';
      return;
    }
    // select
    if (!msg.rows || msg.rows.length === 0) {
      sqlResults.innerHTML = '<div class="sql-empty">No results' + (msg.duration ? ' (' + msg.duration + 'ms)' : '') + '</div>';
      return;
    }
    const cols = msg.columns || Object.keys(msg.rows[0]);
    let html = '<table><thead><tr>';
    cols.forEach(c => { html += '<th>' + escH(c) + '</th>'; });
    html += '</tr></thead><tbody>';
    msg.rows.forEach(row => {
      html += '<tr>';
      cols.forEach(c => {
        const v = row[c];
        html += v == null
          ? '<td class="null-val">NULL</td>'
          : '<td title="' + escH(String(v)) + '">' + escH(String(v)) + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table>';
    sqlResults.innerHTML = html;
  }

  // -- Message handler --
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'tableData':
        columns = msg.columns || [];
        rows = msg.rows || [];
        totalRows = msg.total ?? rows.length;
        pageLimit = msg.limit ?? 100;
        currentPage = msg.page ?? currentPage;
        schema = msg.schema || [];
        pkCol = null;
        for (const s of schema) { if (s.pk) { pkCol = s.name; break; } }
        loading = false;
        editingCell = null;
        renderGrid();
        break;
      case 'queryResult':
        renderSqlResult(msg);
        // Refresh grid data if it was a modify query
        if (msg.changeType === 'modify') {
          vscode.postMessage({ type: 'refresh' });
        }
        break;
      case 'queryError':
        renderSqlResult(msg);
        break;
      case 'cellUpdated':
        // Refresh to show updated data
        vscode.postMessage({ type: 'refresh' });
        break;
      case 'error':
        loading = false;
        gridScroll.innerHTML = '<div class="state-msg" style="color:var(--red)">' + escH(msg.message || 'Error') + '</div>';
        break;
    }
  });

  function escH(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
})();
</script>
</body>
</html>`;
}
