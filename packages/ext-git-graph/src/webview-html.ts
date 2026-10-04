/**
 * The Git Graph panel: one HTML document with its stylesheet and script
 * inlined, since the webview runs in a sandboxed iframe that can load nothing.
 *
 * The markup here is the frame the script fills in. The script itself is one
 * classic <script> assembled from the parts below, which share one scope —
 * webview-script-core.ts says what that allows and what it rules out.
 */
import { WEBVIEW_ICONS } from "./webview-icons.generated.ts";
import { actionsScript } from "./webview-script-actions.ts";
import { coreScript } from "./webview-script-core.ts";
import { graphScript } from "./webview-script-graph.ts";
import { inspectorScript } from "./webview-script-inspector.ts";
import { listScript } from "./webview-script-list.ts";
import { mainScript } from "./webview-script-main.ts";
import { settingsScript } from "./webview-script-settings.ts";
import { graphStyles } from "./webview-styles.ts";

/*
 * The narrowest the message column may get, in px. The graph column is capped
 * against this rather than the other way round: the message is what a list of
 * commits is for, and it used to be the only column able to shrink at all — so
 * in a repository with enough parallel branches the graph took the whole row
 * and the messages were simply not there. Both the stylesheet and the script
 * read it from here, because the script's cap and the CSS floor disagreeing is
 * the same bug in a subtler form.
 */
const MESSAGE_MIN_W = 240;
/** The narrowest the graph column may get, automatically or by dragging. */
const GRAPH_MIN_W = 40;

function icon(name: string, cls?: string): string {
  const svg = WEBVIEW_ICONS[name];
  if (!svg) throw new Error(`Git Graph markup asks for an icon that is not generated: ${name}`);
  return cls ? svg.replace('class="ic"', `class="ic ${cls}"`) : svg;
}

function toolbarHtml(): string {
  return `<header id="toolbar">
      <button type="button" id="branch-selector" class="gg-scope" aria-haspopup="menu">${icon("branch", "ic-sm")}<span id="scope-label" class="scope-lbl">All branches</span>${icon("chev-d", "ic-xs")}</button>
      <div id="find-bar">
        <label class="gg-find">${icon("search", "ic-sm")}<input id="find-input" type="text" placeholder="Find commits" aria-label="Find commits" autocomplete="off" spellcheck="false"><span id="find-count" class="count" aria-live="polite"></span><button type="button" id="find-prev" class="step" title="Previous match (Shift+Enter)" aria-label="Previous match">${icon("chev-u", "ic-xs")}</button><button type="button" id="find-next" class="step" title="Next match (Enter)" aria-label="Next match">${icon("chev-d", "ic-xs")}</button><button type="button" id="find-close" class="clear" title="Clear (Esc)" aria-label="Clear search">${icon("x", "ic-xs")}</button><button type="button" id="find-mode" class="mode" aria-haspopup="menu">Loaded</button></label>
      </div>
      <span class="grow"></span>
      <button type="button" id="btn-stash" class="tool wide opt" aria-haspopup="menu" title="Stashes" aria-label="Stashes">${icon("stash")}<span class="n"></span></button>
      <button type="button" id="btn-worktree" class="tool wide opt" aria-haspopup="menu" title="Worktrees" aria-label="Worktrees">${icon("folder")}<span class="n"></span></button>
      <button type="button" id="btn-submodule" class="tool wide opt hidden" aria-haspopup="menu" title="Submodules" aria-label="Submodules">${icon("cube")}<span class="n"></span></button>
      <span class="sep"></span>
      <span id="sync" class="sync" role="group" aria-label="Sync with the remote">
        <button type="button" id="btn-fetch">${icon("sync", "ic-sm")}<span class="lbl">Fetch</span></button>
        <button type="button" id="btn-pull" disabled>${icon("pull", "ic-sm")}<span class="lbl">Pull</span><span class="num"></span></button>
        <button type="button" id="btn-push" disabled>${icon("push", "ic-sm")}<span class="lbl">Push</span><span class="num hot"></span></button>
      </span>
      <button type="button" id="btn-sync-m" class="sc-sync hidden"></button>
      <span class="sep"></span>
      <button type="button" id="btn-find" class="tool" title="Find (Ctrl+F)" aria-label="Find commits">${icon("search")}</button>
      <button type="button" id="btn-view" class="tool" aria-haspopup="menu" title="View options" aria-label="View options">${icon("options")}</button>
      <button type="button" id="btn-inspector" class="tool" aria-pressed="false" title="Show details" aria-label="Details">${icon("panel-right")}</button>
    </header>`;
}

function listHtml(): string {
  return `<div id="gg-main">
      <div id="graph-area">
        <div id="graph-container" class="scroll-thin">
          <div id="graph-header" class="commit-row header-row" role="row">
            <div class="col-graph">Graph<div class="graph-resize-handle" id="graph-resize-handle"></div></div>
            <div class="col-message">Message</div>
            <div class="col-changes">Changes</div>
            <div class="col-author">Author</div>
            <div class="col-date">Date</div>
            <div class="col-hash">Hash</div>
          </div>
          <div id="commit-list-wrapper">
            <div id="graph-clip"><div id="graph-svg-container"></div></div>
            <div id="commit-list" role="rowgroup"></div>
          </div>
          <div id="loading" class="loading hidden">Loading…</div>
        </div>
        <div id="graph-pan-bar" class="hidden" aria-hidden="true"><div id="graph-pan-thumb"></div></div>
        <div id="scroll-markers" aria-hidden="true"></div>
        <div id="search-results" class="search-results hidden scroll-thin"></div>
      </div>
      <div id="sheet-scrim" class="hidden"></div>
      <aside id="detail-panel" class="detail-panel scroll-thin" aria-label="Details"></aside>
    </div>`;
}

function settingsHtml(): string {
  const row = (label: string, control: string) => `<div class="setting-row"><label>${label}</label>${control}</div>`;
  const check = (id: string) => `<input type="checkbox" id="${id}">`;
  return `<div id="settings-panel" role="dialog" aria-label="Git Graph settings">
      <div class="settings-header">
        <h3>Git Graph settings</h3>
        <button type="button" id="settings-close" class="tool" title="Close" aria-label="Close settings">${icon("x")}</button>
      </div>
      <div class="settings-body scroll-thin">
        <details class="settings-section" open>
          <summary>General</summary>
          ${row("Commits per page", '<input type="number" id="s-maxCommits" min="10" max="10000" step="50">')}
          ${row("Show tags", check("s-showTags"))}
          ${row("Show stashes", check("s-showStashes"))}
          ${row("Show remote branches", check("s-showRemoteBranches"))}
          ${row("First parent only", check("s-firstParentOnly"))}
          ${row("Graph style", '<select id="s-graphStyle"><option value="rounded">Rounded</option><option value="angular">Angular</option></select>')}
          ${row("Dates", '<select id="s-dateFormat"><option value="relative">Relative</option><option value="absolute">Absolute</option><option value="iso">ISO</option></select>')}
          ${row("Order", '<select id="s-commitOrdering"><option value="topo">Topological</option><option value="date">Commit date</option><option value="author-date">Author date</option></select>')}
          ${row("Fetch automatically", '<select id="s-autoFetchInterval"><option value="0">Never</option><option value="10">Every 10 seconds</option><option value="30">Every 30 seconds</option><option value="60">Every minute</option><option value="120">Every 2 minutes</option><option value="300">Every 5 minutes</option></select>')}
        </details>
        <details class="settings-section" open>
          <summary>Columns</summary>
          <p>The View menu has the same list. A narrow panel drops the last few by itself, whatever is ticked here.</p>
          ${row("Changes", check("s-colChanges"))}
          ${row("Author", check("s-colAuthor"))}
          ${row("Date", check("s-colDate"))}
          ${row("Hash", check("s-colHash"))}
        </details>
        <details class="settings-section" open>
          <summary>Your name and email</summary>
          <p>What this repository's commits are signed with (git config user.name and user.email).</p>
          ${row("Name", '<input type="text" id="s-userName" placeholder="user.name">')}
          ${row("Email", '<input type="text" id="s-userEmail" placeholder="user.email">')}
          <div class="setting-row"><span></span><button type="button" id="s-saveUser" class="btn xs outline">Save</button></div>
        </details>
        <details class="settings-section" open>
          <summary>Remotes</summary>
          <div id="s-remotes-list"></div>
          <div class="add-remote-form">
            <input type="text" id="s-newRemoteName" placeholder="Name" aria-label="Remote name">
            <input type="text" id="s-newRemoteUrl" placeholder="URL" aria-label="Remote URL">
            <button type="button" id="s-addRemote" class="btn xs outline">${icon("plus", "ic-sm")}Add remote</button>
          </div>
        </details>
        <details class="settings-section">
          <summary>Issue links</summary>
          <p>Turn issue references in commit messages into links.</p>
          <div id="issue-rules-list"></div>
          <button type="button" id="add-issue-rule" class="btn xs outline">${icon("plus", "ic-sm")}Add rule</button>
        </details>
        <details class="settings-section">
          <summary>Pull requests</summary>
          ${row("Provider", '<select id="pr-provider"><option value="">Off</option><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="bitbucket">Bitbucket</option><option value="custom">Custom</option></select>')}
          <div id="pr-config" class="hidden">
            ${row("Owner", '<input type="text" id="pr-owner" placeholder="owner or organisation">')}
            ${row("Repository", '<input type="text" id="pr-repo" placeholder="repository name">')}
            ${row("Target branch", '<input type="text" id="pr-target" placeholder="main">')}
            ${row("Link", '<input type="text" id="pr-url-template" placeholder="https://…">')}
            <p class="settings-note" id="pr-vars"></p>
            <div class="setting-row"><span></span><button type="button" id="pr-save" class="btn xs outline">Save</button></div>
          </div>
        </details>
      </div>
    </div>`;
}

export function getWebviewHtml(): string {
  const script = [
    coreScript(MESSAGE_MIN_W, GRAPH_MIN_W),
    graphScript(),
    listScript(),
    inspectorScript(),
    actionsScript(),
    settingsScript(),
    mainScript(),
  ].join("\n");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${graphStyles(MESSAGE_MIN_W)}
</style>
</head>
<body>
  <div id="app">
    ${toolbarHtml()}
    <div id="op-banner" class="op-banner hidden" role="status"></div>
    ${listHtml()}
    <footer id="status-bar">
      <span id="status-text">Loading repository…</span>
      <span class="grow"></span>
      <button type="button" id="btn-load-more" class="btn xs ghost hidden">Load more</button>
    </footer>
  </div>
  ${settingsHtml()}
  <div id="menu-scrim" class="hidden"></div>
  <div id="context-menu" class="menu hidden" role="menu"></div>
  <div id="toast-host" aria-live="polite"></div>
<script>
${script}
</script>
</body>
</html>`;
}
