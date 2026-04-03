/**
 * WebviewPanel for SQL query editor + results display.
 * Communicates with the extension via postMessage.
 */

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Create the HTML content for the query webview panel */
export function getQueryPanelHtml(connectionName: string, tableName?: string): string {
  const initialQuery = tableName ? `SELECT * FROM ${escHtml(tableName)} LIMIT 100;` : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1e1e2e; color: #cdd6f4; padding: 12px; font-size: 13px; }
  .header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .header h3 { font-size: 14px; font-weight: 600; }
  .header .badge { background: #313244; padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #a6adc8; }
  textarea { width: 100%; height: 80px; background: #313244; border: 1px solid #45475a; border-radius: 6px; color: #cdd6f4; padding: 8px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; resize: vertical; }
  textarea:focus { outline: none; border-color: #89b4fa; }
  .actions { display: flex; gap: 8px; margin: 8px 0; }
  button { background: #89b4fa; color: #1e1e2e; border: none; padding: 6px 16px; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; }
  button:hover { background: #74c7ec; }
  button.secondary { background: #313244; color: #cdd6f4; }
  .status { font-size: 11px; color: #a6adc8; margin: 4px 0; }
  .error { color: #f38ba8; background: #45475a; padding: 8px; border-radius: 4px; margin: 8px 0; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
  th { background: #313244; text-align: left; padding: 6px 8px; border-bottom: 1px solid #45475a; font-weight: 600; position: sticky; top: 0; }
  td { padding: 4px 8px; border-bottom: 1px solid #313244; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tr:hover td { background: #313244; }
  .results { max-height: 60vh; overflow: auto; border: 1px solid #45475a; border-radius: 6px; }
  .empty { text-align: center; padding: 24px; color: #6c7086; }
</style>
</head>
<body>
  <div class="header">
    <h3>Query</h3>
    <span class="badge">${escHtml(connectionName)}</span>
  </div>
  <textarea id="sql" placeholder="Enter SQL query...">${initialQuery}</textarea>
  <div class="actions">
    <button id="run">Run Query</button>
    <button class="secondary" id="clear">Clear</button>
  </div>
  <div id="status" class="status"></div>
  <div id="error" style="display:none"></div>
  <div id="results"></div>
<script>
  const vscode = acquireVsCodeApi();
  const sqlEl = document.getElementById('sql');
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');
  const resultsEl = document.getElementById('results');

  document.getElementById('run').addEventListener('click', () => {
    const sql = sqlEl.value.trim();
    if (!sql) return;
    statusEl.textContent = 'Running...';
    errorEl.style.display = 'none';
    resultsEl.innerHTML = '';
    vscode.postMessage({ type: 'executeQuery', sql });
  });

  document.getElementById('clear').addEventListener('click', () => {
    sqlEl.value = '';
    statusEl.textContent = '';
    errorEl.style.display = 'none';
    resultsEl.innerHTML = '';
  });

  sqlEl.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      document.getElementById('run').click();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'queryResult') {
      if (msg.changeType === 'modify') {
        statusEl.textContent = (msg.rowsAffected ?? 0) + ' row(s) affected' + (msg.duration ? ' in ' + msg.duration + 'ms' : '');
        resultsEl.innerHTML = '';
        return;
      }
      const rows = msg.rows || [];
      statusEl.textContent = rows.length + ' row(s) returned' + (msg.duration ? ' in ' + msg.duration + 'ms' : '');
      if (rows.length === 0) {
        resultsEl.innerHTML = '<div class="empty">No results</div>';
        return;
      }
      function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
      const cols = msg.columns || Object.keys(rows[0]);
      let html = '<div class="results"><table><thead><tr>';
      cols.forEach(c => { html += '<th>' + esc(c) + '</th>'; });
      html += '</tr></thead><tbody>';
      rows.forEach(row => {
        html += '<tr>';
        cols.forEach(c => {
          const v = row[c];
          html += '<td>' + (v === null ? '<span style="color:#6c7086">NULL</span>' : esc(v)) + '</td>';
        });
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      resultsEl.innerHTML = html;
    } else if (msg.type === 'queryError') {
      statusEl.textContent = '';
      errorEl.textContent = msg.error;
      errorEl.style.display = 'block';
      errorEl.className = 'error';
    }
  });
</script>
</body>
</html>`;
}
