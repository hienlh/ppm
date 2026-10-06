/**
 * @ppm/ext-git-graph — Git Graph extension for PPM.
 * Visualizes git commit history as an interactive graph in a webview.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { CommitDraftData, GitGraphSettings, PpmGitChanges, WebviewToExt, Worktree } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import { getWebviewHtml } from "./webview-html.ts";
import type { VscodeApi } from "./git-exec.ts";
import {
  assertSafeFilePaths, assertValidHash, assertValidRef, assertValidRemote, spawnGit,
} from "./git-exec.ts";
import { authHeaders, getBaseUrl, initPpmApi, resolveFileTab } from "./ppm-api.ts";
import { registerBlameView } from "./blame-view.ts";
import { registerFileHistoryView } from "./file-history-view.ts";
import { registerCompareView } from "./compare-view.ts";
import { registerRebaseView } from "./rebase-view.ts";
import { registerReflogView } from "./reflog-view.ts";
import { parseSubmoduleStatus } from "./submodule-parser.ts";
import { openPanel } from "./panel-registry.ts";
import { createPpmRepoResolver, ppmGit, remoteWeb } from "./ppm-git.ts";
import { navigateToPanel } from "./panel-nav.ts";
import { registerViewCommand } from "./register-view-command.ts";
import { buildSearchArgs, isSearchMode, parseSearchResults } from "./commit-search.ts";

function getSettings(context: ExtensionContext): GitGraphSettings {
  return { ...DEFAULT_SETTINGS, ...(context.globalState.get<Partial<GitGraphSettings>>("settings") || {}) };
}

const VALID_SETTING_KEYS = new Set<string>([
  "maxCommits", "showTags", "showStashes", "showRemoteBranches", "graphStyle",
  "firstParentOnly", "dateFormat", "commitOrdering", "issueLinkingRules", "prCreation",
  "autoFetchInterval",
  "colChanges", "colAuthor", "colDate", "colHash",
]);

async function saveSetting(context: ExtensionContext, key: string, value: unknown): Promise<GitGraphSettings> {
  if (!VALID_SETTING_KEYS.has(key)) throw new Error(`Invalid setting key: ${key}`);
  const settings = getSettings(context);
  (settings as any)[key] = value;
  await context.globalState.update("settings", settings);
  return settings;
}

const SYNC_ACTIONS = ["fetch", "pull", "push", "publish", "sync"] as const;
type SyncAction = typeof SYNC_ACTIONS[number];

/** What the toolbar's sync buttons may ask for; anything else is refused. */
function syncAction(value: unknown): SyncAction {
  if (!SYNC_ACTIONS.includes(value as SyncAction)) throw new Error(`Unknown sync action: "${String(value)}"`);
  return value as SyncAction;
}

/** A worktree directory from the panel: typed by the user, or read back from `git worktree list`. */
function assertWorktreePath(value: unknown): string {
  const s = typeof value === "string" ? value : "";
  if (!s.trim() || s.startsWith("-") || /[\x00-\x1f\x7f]/.test(s)) throw new Error(`Invalid worktree path: "${s}"`);
  return s;
}

/**
 * The name the panel files a request's answer under. An `error` from the
 * handler carries it, so the button waiting on that request stops waiting;
 * requests nobody waits on have none.
 */
function actionKeyFor(msg: WebviewToExt): string | undefined {
  switch (msg.command) {
    case "gitAction":
    case "sync":
      return typeof msg.action === "string" ? msg.action : undefined;
    case "operation":
      return `operation:${msg.action === "continue" ? "continue" : "abort"}`;
    case "stageFiles":
    case "unstageFiles":
    case "discardFiles":
    case "undoDiscard":
    case "commitStaged":
    case "undoCommit":
    case "stash":
    case "stashAction":
    case "addWorktree":
    case "removeWorktree":
    case "pruneWorktrees":
    case "updateSubmodule":
      return msg.command;
    default:
      return undefined;
  }
}

export function activate(context: ExtensionContext, vscode: VscodeApi): void {
  initPpmApi();

  registerViewCommand({
    context,
    vscode,
    command: "git-graph.view",
    label: "Git Graph",
    open: (projectPath) => openGitGraph(vscode, context, projectPath),
  });

  registerBlameView(context, vscode);
  registerFileHistoryView(context, vscode);
  registerCompareView(context, vscode);
  registerRebaseView(context, vscode);
  registerReflogView(context, vscode);

  console.log("[ext-git-graph] activated");
}

export function deactivate(): void {
  console.log("[ext-git-graph] deactivated");
}

function openGitGraph(
  vscode: VscodeApi,
  context: ExtensionContext,
  projectPath: string,
): void {
  const dirName = projectPath.split(/[\\/]/).filter(Boolean).pop() || "Git Graph";

  // Declared before openPanel so the message handler can reach the panel it is
  // attached to without threading it through every handler signature.
  let changesPollTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  // The branch the graph is scoped to. Every refresh the host starts itself —
  // after an action, after a setting changed — has to ask for the same window
  // the user is looking at, or the graph silently jumps back to all branches.
  let scope = "all";
  const ppmRepo = createPpmRepoResolver(projectPath);
  // Comes back in the draft broadcast, so other surfaces can tell this panel's
  // typing from their own.
  const draftClientId = `git-graph:${Math.random().toString(36).slice(2, 10)}`;

  const panel = openPanel({
    vscode,
    viewType: "git-graph.view",
    title: `Git Graph: ${dirName}`,
    projectPath,
    html: getWebviewHtml(),
    onDispose: () => {
      disposed = true;
      if (changesPollTimer) clearInterval(changesPollTimer);
    },
    onMessage: async (raw: unknown) => {
    // `reqId`: sent with a request that waits for its answer.
    const msg = raw as WebviewToExt & { reqId?: number };
    // Panel is bound to its project for life — reopening a project recreates
    // the panel, so the closure path is always current.
    const pp = projectPath;
    // Messages are handled concurrently, so two requests of one action can finish
    // in either order: every answer echoes the id of the request it answers.
    const runAction = (action: string, run: () => Promise<unknown>, refresh: Parameters<typeof answerAction>[3]) =>
      answerAction(msg.reqId, action, run, refresh);
    try {
      switch (msg.command) {
        case "ready":
          // Before anything is drawn: the settings say which columns the table
          // has, and until this arrived they were only fetched when the
          // settings panel was opened — so a saved choice took effect on the
          // second look at the panel rather than the first.
          await panel.webview.postMessage({ command: "loadSettings", data: getSettings(context) });
          refsSeen = await readRefs().catch(() => null);
          await handleRepoInfo(vscode, panel, pp);
          await readCommits(undefined, 0);
          void refreshChanges();
          handleWorktrees(vscode, panel, pp); // fire-and-forget
          handleStashes(vscode, panel, pp); // fire-and-forget
          handleSubmodules(vscode, panel, pp); // fire-and-forget
          break;
        case "requestRepoInfo":
          await handleRepoInfo(vscode, panel, pp);
          break;
        case "requestCommits":
          scope = msg.branch || "all";
          await readCommits(msg.maxCommits, msg.skip ?? 0);
          break;
        case "requestCommitDetails":
          await handleCommitDetails(vscode, panel, pp, msg.hash);
          break;
        case "requestStashDetails":
          await handleStashDetails(vscode, panel, pp, msg.hash);
          break;
        case "requestChanges":
          await refreshChanges();
          break;
        case "saveDraft": {
          await ppmGit<CommitDraftData>(await ppmRepo(), "PUT", "/commit-draft", {
            message: String(msg.message ?? ""),
            clientId: draftClientId,
          });
          break;
        }
        case "stageFiles":
        case "unstageFiles":
        case "discardFiles": {
          const route = msg.command === "stageFiles" ? "/stage" : msg.command === "unstageFiles" ? "/unstage" : "/discard";
          // Checked inside the action, so a refused path is answered like any
          // other failure rather than leaving the button waiting.
          await runAction(msg.command, async () => {
            const paths = Array.isArray(msg.paths) ? msg.paths.map(String) : [];
            assertSafeFilePaths(paths, pp);
            return ppmGit<{ undo?: unknown }>(await ppmRepo(), "POST", route, { files: paths });
          }, "changes");
          break;
        }
        case "undoDiscard":
          await runAction("undoDiscard", async () => ppmGit(await ppmRepo(), "POST", "/discard/undo", { id: String(msg.id) }), "changes");
          break;
        case "commitStaged":
          await runAction("commitStaged", async () => {
            const ref = await ppmRepo();
            const done = await ppmGit<{ hash: string }>(ref, "POST", "/commit", {
              message: String(msg.message ?? ""),
              amend: !!msg.amend,
              signoff: !!msg.signoff,
            });
            if (!msg.push) return done;
            // The commit stands even if the push fails; say which half failed.
            try {
              const changes = await ppmGit<PpmGitChanges>(ref, "GET", "/changes");
              const publish = !changes.branch.upstream || changes.branch.upstreamGone;
              await ppmGit(ref, "POST", publish ? "/publish" : "/push", publish ? undefined : {});
            } catch (e) {
              throw new Error(`Committed, but the push failed: ${e instanceof Error ? e.message : String(e)}`);
            }
            return { ...done, pushed: true };
          }, "all");
          break;
        case "undoCommit":
          // The commit the panel named: PPM refuses once it is no longer the last one.
          await runAction("undoCommit", async () => ppmGit(await ppmRepo(), "POST", "/commit/undo", { hash: String(msg.hash ?? "") }), "all");
          break;
        case "sync": {
          const action = syncAction(msg.action);
          await runAction(action, async () => {
            const ref = await ppmRepo();
            switch (action) {
              case "fetch": {
                // Every remote, pruned: what the toolbar's Fetch promises. Through
                // PPM rather than git directly, so the app's status bar and Source
                // Control hear of it at once. The answer carries how far behind
                // that left the branch.
                await ppmGit(ref, "POST", "/fetch", { prune: true });
                const changes = await ppmGit<PpmGitChanges>(ref, "GET", "/changes");
                return { behind: changes.branch.behind };
              }
              case "sync":
                await ppmGit(ref, "POST", "/pull", {});
                return ppmGit(ref, "POST", "/push", {});
              case "publish":
                return ppmGit(ref, "POST", "/publish");
              default:
                return ppmGit(ref, "POST", `/${action}`, {});
            }
          }, "all");
          break;
        }
        case "stash":
          await runAction("stash", async () => {
            const ref = await ppmRepo();
            // The new entry, so the toast's Undo can pop exactly it. Never the one on top:
            // with nothing it could save, git still succeeds and that one is older.
            const { stash } = await ppmGit<{ stash: { index: number; hash: string } | null }>(ref, "POST", "/stash", {
              message: typeof msg.message === "string" && msg.message ? msg.message : undefined,
              includeUntracked: msg.includeUntracked === true,
            });
            if (!stash) throw new Error("Nothing was stashed: git found no change it could save.");
            return stash;
          }, "all");
          break;
        case "stashAction": {
          const action = msg.action === "pop" || msg.action === "drop" ? msg.action : "apply";
          await runAction("stashAction", async () => ppmGit(await ppmRepo(), "POST", `/stash/${action}`, {
            index: Number(msg.index),
            hash: String(msg.hash ?? ""),
          }), "all");
          break;
        }
        case "operation": {
          const action = msg.action === "continue" ? "continue" : "abort";
          await runAction(`operation:${action}`, async () => ppmGit(await ppmRepo(), "POST", `/operation/${action}`, {}), "all");
          break;
        }
        case "openReview": {
          const ref = await ppmRepo();
          const path = typeof msg.path === "string" && msg.path ? msg.path : undefined;
          if (path) assertSafeFilePaths([path], pp);
          await vscode.window.openTab("git-review", "Review changes", ref.projectName, {
            projectName: ref.projectName,
            ...(ref.repo ? { repo: ref.repo } : {}),
            ...(path ? { path } : {}),
          });
          break;
        }
        case "openDiff": {
          assertSafeFilePaths([msg.filePath], pp);
          const fileName = msg.filePath.split(/[\\/]/).pop() || msg.filePath;
          const target = await resolveFileTab(pp, msg.filePath);
          const side = msg.hash === "uncommitted" ? "working tree" : msg.hash === "staged" ? "staged" : msg.hash.substring(0, 7);
          await vscode.window.openTab("git-diff", `${fileName} (${side})`, target.projectName, {
            ...target,
            ...(msg.parentHash ? { ref1: msg.parentHash } : {}),
            ...(msg.hash !== "uncommitted" && msg.hash !== "staged" ? { ref2: msg.hash } : {}),
          });
          break;
        }
        case "requestSettings":
          await panel.webview.postMessage({ command: "loadSettings", data: getSettings(context) });
          break;
        case "updateSetting": {
          const updated = await saveSetting(context, msg.key, msg.value);
          await panel.webview.postMessage({ command: "loadSettings", data: updated });
          if (["maxCommits", "firstParentOnly", "commitOrdering"].includes(msg.key)) {
            await readCommits(updated.maxCommits, 0);
          }
          break;
        }
        case "requestUserDetails": {
          const [nameResult, emailResult] = await Promise.all([
            spawnGit(vscode, ["config", "user.name"], pp),
            spawnGit(vscode, ["config", "user.email"], pp),
          ]);
          await panel.webview.postMessage({
            command: "loadUserDetails",
            data: { name: nameResult.stdout.trim(), email: emailResult.stdout.trim() },
          });
          break;
        }
        case "updateUserDetails": {
          if (msg.name !== undefined) await spawnGit(vscode, ["config", "user.name", msg.name], pp);
          if (msg.email !== undefined) await spawnGit(vscode, ["config", "user.email", msg.email], pp);
          const [n, e] = await Promise.all([
            spawnGit(vscode, ["config", "user.name"], pp),
            spawnGit(vscode, ["config", "user.email"], pp),
          ]);
          await panel.webview.postMessage({ command: "loadUserDetails", data: { name: n.stdout.trim(), email: e.stdout.trim() } });
          break;
        }
        case "addRemote": {
          const remoteUrl = String(msg.url || "");
          if (!remoteUrl || remoteUrl.startsWith("-")) throw new Error("Invalid remote URL");
          await spawnGit(vscode, ["remote", "add", assertValidRemote(msg.name), remoteUrl], pp);
          await handleRepoInfo(vscode, panel, pp);
          break;
        }
        case "removeRemote":
          await spawnGit(vscode, ["remote", "remove", assertValidRemote(msg.name)], pp);
          await handleRepoInfo(vscode, panel, pp);
          break;
        case "editRemoteUrl": {
          const editUrl = String(msg.url || "");
          if (!editUrl || editUrl.startsWith("-")) throw new Error("Invalid remote URL");
          await spawnGit(vscode, ["remote", "set-url", assertValidRemote(msg.name), editUrl], pp);
          await handleRepoInfo(vscode, panel, pp);
          break;
        }
        case "requestOwnerRepo": {
          const result = await spawnGit(vscode, ["remote", "get-url", "origin"], pp);
          const url = result.stdout.trim();
          const match = url.match(/[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
          await panel.webview.postMessage({
            command: "loadOwnerRepo",
            data: match ? { owner: match[1], repo: match[2] } : { owner: "", repo: "" },
          });
          break;
        }
        case "gitAction":
          await handleGitAction(vscode, panel, pp, msg.action, msg.args ?? {}, () => refreshAfter(refreshAll), msg.reqId);
          break;
        case "openFile": {
          assertSafeFilePaths([msg.filePath], pp);
          const target = await resolveFileTab(pp, msg.filePath);
          await vscode.window.openTab("editor", msg.filePath, target.projectName, target);
          break;
        }
        case "requestWorktrees":
          await handleWorktrees(vscode, panel, pp);
          break;
        case "requestStashes":
          await handleStashes(vscode, panel, pp);
          break;
        case "requestSubmodules":
          await handleSubmodules(vscode, panel, pp);
          break;
        case "updateSubmodule":
          await runAction("updateSubmodule", async () => {
            // A path from the webview, so it gets the same treatment as any other.
            // `--` keeps a path that starts with a dash out of the option list.
            const subPath = String(msg.path || "");
            assertSafeFilePaths([subPath], pp);
            const updateRes = await spawnGit(
              vscode,
              ["submodule", "update", "--init", "--recursive", "--", subPath],
              pp,
              180_000,
            );
            if (updateRes.exitCode !== 0) {
              throw new Error(updateRes.stderr.trim() || "git could not update that submodule.");
            }
          }, () => handleSubmodules(vscode, panel, pp));
          break;
        case "openSubmodule": {
          const subPath = String(msg.path || "");
          assertSafeFilePaths([subPath], pp);
          await openProjectAt(vscode, `${pp}/${subPath}`, "submodule");
          break;
        }
        case "searchCommits": {
          if (!isSearchMode(msg.mode)) throw new Error(`Unknown search mode: "${msg.mode}"`);
          const searchArgs = buildSearchArgs({ mode: msg.mode, text: msg.text }, 200, pp);
          const searchRes = await spawnGit(vscode, searchArgs, pp, 60_000);
          if (searchRes.exitCode !== 0) {
            throw new Error(searchRes.stderr.trim() || "Search failed.");
          }
          await panel.webview.postMessage({
            command: "loadSearchResults",
            data: { mode: msg.mode, text: msg.text, hits: parseSearchResults(searchRes.stdout) },
          });
          break;
        }
        case "openBlame": {
          assertSafeFilePaths([msg.filePath], pp);
          const fileName = msg.filePath.split(/[\\/]/).pop() || msg.filePath;
          await navigateToPanel({
            vscode,
            context,
            viewType: "git-graph.blame",
            title: `Blame: ${fileName}`,
            projectPath: pp,
            target: { filePath: msg.filePath, rev: msg.hash ? assertValidHash(msg.hash) : undefined },
          });
          break;
        }
        case "openFileHistory": {
          assertSafeFilePaths([msg.filePath], pp);
          const fileName = msg.filePath.split(/[\\/]/).pop() || msg.filePath;
          await navigateToPanel({
            vscode,
            context,
            viewType: "git-graph.fileHistory",
            title: `History: ${fileName}`,
            projectPath: pp,
            target: { filePath: msg.filePath },
          });
          break;
        }
        case "openCompare":
          await navigateToPanel({
            vscode,
            context,
            viewType: "git-graph.compare",
            title: "Compare",
            projectPath: pp,
            target: {
              ...(msg.ref1 ? { ref1: assertValidRef(msg.ref1, "ref1") } : {}),
              ...(msg.ref2 ? { ref2: assertValidRef(msg.ref2, "ref2") } : {}),
            },
          });
          break;
        case "openReflog":
          await navigateToPanel({
            vscode,
            context,
            viewType: "git-graph.reflog",
            title: "Reflog",
            projectPath: pp,
          });
          break;
        case "addWorktree":
          await runAction("addWorktree", async () => {
            const addArgs = ["worktree", "add"];
            if (msg.newBranch) addArgs.push("-b", assertValidRef(msg.newBranch, "newBranch"));
            addArgs.push(assertWorktreePath(msg.path));
            if (msg.branch) addArgs.push(assertValidRef(msg.branch, "branch"));
            // A commit or a branch name: both are what `git worktree add` takes here.
            if (msg.startPoint) addArgs.push(assertValidRef(msg.startPoint, "startPoint"));
            const res = await spawnGit(vscode, addArgs, pp);
            if (res.exitCode !== 0) throw new Error(res.stderr.trim() || "git could not add the worktree.");
          }, () => handleWorktrees(vscode, panel, pp));
          break;
        case "removeWorktree":
          await runAction("removeWorktree", async () => {
            const res = await spawnGit(vscode, ["worktree", "remove", ...(msg.force ? ["--force"] : []), assertWorktreePath(msg.path)], pp);
            if (res.exitCode !== 0) throw new Error(res.stderr.trim() || "git could not remove the worktree.");
          }, () => handleWorktrees(vscode, panel, pp));
          break;
        case "pruneWorktrees":
          await runAction("pruneWorktrees", async () => {
            const res = await spawnGit(vscode, ["worktree", "prune"], pp);
            if (res.exitCode !== 0) throw new Error(res.stderr.trim() || "git could not prune the worktrees.");
          }, () => handleWorktrees(vscode, panel, pp));
          break;
        case "openWorktree":
          await openProjectAt(vscode, msg.path, "Worktree");
          break;
        case "openConflictFile": {
          assertSafeFilePaths([msg.filePath], pp);
          const target = await resolveFileTab(pp, msg.filePath);
          // Opens as conflict-editor tab (Phase 4 will wire this properly)
          await vscode.window.openTab("conflict-editor", `Conflict: ${msg.filePath.split(/[\\/]/).pop()}`, target.projectName, target);
          break;
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // `failed` and `reqId` name the request this answers, so a button waiting on it stops waiting.
      await panel.webview.postMessage({ command: "error", message: errMsg, failed: actionKeyFor(msg), reqId: msg.reqId });
    }
    },
  });

  /**
   * The working tree and the shared commit message, from PPM's own routes.
   *
   * Coalesced: a refresh asked for while one is in flight runs once more after
   * it rather than being dropped, because the one in flight may have read the
   * tree from before the action that asked.
   */
  let changesRun: Promise<void> | null = null;
  let changesAgain = false;
  async function readChangesOnce(): Promise<void> {
    try {
      const ref = await ppmRepo();
      const [changes, draft] = await Promise.all([
        ppmGit<PpmGitChanges>(ref, "GET", "/changes"),
        ppmGit<CommitDraftData>(ref, "GET", "/commit-draft"),
      ]);
      if (disposed) return;
      await panel.webview.postMessage({ command: "loadChanges", data: changes });
      await panel.webview.postMessage({ command: "loadDraft", data: draft });
    } catch (e) {
      if (disposed) return;
      await panel.webview.postMessage({
        command: "loadChanges",
        data: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  function refreshChanges(): Promise<void> {
    if (changesRun) {
      changesAgain = true;
      return changesRun;
    }
    changesRun = (async () => {
      do {
        changesAgain = false;
        await readChangesOnce();
      } while (changesAgain && !disposed);
    })().finally(() => { changesRun = null; });
    return changesRun;
  }

  async function refreshAll(): Promise<void> {
    // Taken before the reads, so a ref that moves during them is still a change at the next poll.
    refsSeen = await readRefs().catch(() => refsSeen);
    await handleRepoInfo(vscode, panel, projectPath);
    await readCommits(undefined, 0);
    await refreshChanges();
  }

  /**
   * The history for the panel's branch filter. A filter on a branch that is gone comes
   * back as every branch, and is dropped here too: kept, it would fail every refresh.
   */
  async function readCommits(maxCommits: number | undefined, skip: number): Promise<void> {
    const asked = scope;
    const shown = await handleRequestCommits(vscode, panel, projectPath, context, maxCommits, skip, asked);
    // Unless a newer request chose a filter meanwhile.
    if (shown && scope === asked) scope = shown;
  }

  /*
   * Refs that move while HEAD stays put — a stash pushed, popped or dropped, a branch or a tag
   * made or deleted, a fetch — when it happens outside this panel, in a terminal or another
   * tool. The working-tree poll cannot see those, so they showed only after View → Refresh.
   * Two cheap reads each poll say whether anything moved; only then is the rest read again.
   */
  let refsSeen: string | null = null;
  let refsBusy = false;
  async function readRefs(): Promise<string> {
    const [refs, stashes] = await Promise.all([
      spawnGit(vscode, ["for-each-ref", "--format=%(refname) %(objectname)"], projectPath, 10_000),
      // A stash dropped from below the top leaves refs/stash where it was; only its list moves.
      spawnGit(vscode, ["stash", "list", "--format=%H"], projectPath, 10_000),
    ]);
    if (refs.exitCode !== 0) throw new Error(refs.stderr || "git for-each-ref failed");
    return refs.stdout + "\n" + stashes.stdout;
  }
  async function followOutsideRefChanges(): Promise<void> {
    if (refsBusy) return;
    refsBusy = true;
    try {
      const now = await readRefs();
      const before = refsSeen;
      refsSeen = now;
      if (before === null || before === now || disposed) return;
      await handleRepoInfo(vscode, panel, projectPath);
      await readCommits(undefined, 0);
      await handleWorktrees(vscode, panel, projectPath);
    } catch {
      // Unreadable this time; the next poll asks again.
    } finally {
      refsBusy = false;
    }
  }

  /**
   * One write: the outcome as an `actionResult` answering request `reqId`, then
   * whatever it changed read again — the working tree only, the history too, or
   * a list of its own. A failed write is refreshed as well, since a pull that
   * stops on a conflict has changed the tree all the same.
   */
  async function answerAction(
    reqId: number | undefined,
    action: string,
    run: () => Promise<unknown>,
    refresh: "changes" | "all" | (() => Promise<void>),
  ): Promise<void> {
    let result: { ok: boolean; error?: string; data?: unknown };
    try {
      result = { ok: true, data: await run() };
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    await panel.webview.postMessage({ command: "actionResult", action, result, reqId });
    await refreshAfter(refresh === "all" ? refreshAll : refresh === "changes" ? refreshChanges : refresh);
  }

  /**
   * A re-read after an answer has gone out. It may not throw into the message
   * handler, which would report the action as failed after its answer already
   * said how it went.
   */
  async function refreshAfter(refresh: () => Promise<void>): Promise<void> {
    try {
      await refresh();
    } catch (e) {
      if (disposed) return;
      await panel.webview.postMessage({ command: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  changesPollTimer = setInterval(() => {
    if (disposed) return;
    // Refs first: a commit made in a terminal then reaches the panel as history before the
    // working tree that goes with it, and the panel has no reason to ask for the history again.
    void followOutsideRefChanges().finally(() => {
      if (!disposed) void refreshChanges();
    });
  }, 5_000);
}


async function handleRepoInfo(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
): Promise<void> {
  const [branchResult, tagResult, remoteResult, stashResult, headResult, headHashResult] = await Promise.all([
    spawnGit(vscode, ["branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(HEAD)|%(symref)"], projectPath),
    spawnGit(vscode, ["tag", "-l", "--format=%(refname:short)|%(objectname:short)"], projectPath),
    spawnGit(vscode, ["remote", "-v"], projectPath),
    spawnGit(vscode, ["stash", "list", `--format=${STASH_FORMAT}`], projectPath),
    spawnGit(vscode, ["rev-parse", "--abbrev-ref", "HEAD"], projectPath),
    spawnGit(vscode, ["rev-parse", "HEAD"], projectPath),
  ]);

  const branches = parseBranches(branchResult.stdout);
  const tags = parseTags(tagResult.stdout);
  const remotes = parseRemotes(remoteResult.stdout);
  const stashes = parseStashes(stashResult.stdout);
  const currentBranch = headResult.stdout.trim();
  const headHash = headHashResult.stdout.trim();
  const webRemote = remotes.find((r) => r.name === "origin") ?? remotes[0];

  await panel.webview.postMessage({
    command: "loadRepoInfo",
    data: {
      path: projectPath, branches, tags, remotes, stashes, head: headHash, currentBranch,
      remoteWeb: webRemote ? remoteWeb(webRemote.fetchUrl || webRemote.pushUrl) : null,
    },
  });
}

/**
 * Which commit-window requests a panel still wants the answers to.
 *
 * Scrolling fires one `requestCommits` per page and each one spawns two git
 * processes — the log and the lines-changed pass — with nothing stopping the
 * previous pair. Pages are additive, so a late *append* is still wanted; what
 * is not is anything from before the list was last thrown away. Switching
 * branch or refreshing sends `skip: 0`, which replaces the list, and an
 * in-flight page-two append landing after that appends the old branch's
 * commits to the new branch's first page.
 *
 * So responses are dropped by generation rather than cancelled — there is no
 * abort to reach for through the extension spawn API — and the second pass is
 * skipped outright when it is already stale, which is also what keeps the
 * process count down while somebody scrolls.
 */
export interface CommitRequestState {
  latest: number;
  lastReset: number;
  /** How many commits the panel's list holds, by the answers sent so far. */
  shown?: number;
}

/** Record a new request and return its generation. */
export function beginCommitRequest(state: CommitRequestState, skip: number): number {
  state.latest += 1;
  if (skip === 0) state.lastReset = state.latest;
  return state.latest;
}

/** True when the list this request was answering has since been replaced. */
export function isStaleCommitRequest(state: CommitRequestState, generation: number): boolean {
  return generation < state.lastReset;
}

const commitRequests = new WeakMap<object, CommitRequestState>();

/** Posts the commit window; answers with the branch filter it was read for, or undefined when it was dropped as stale. */
async function handleRequestCommits(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
  context?: ExtensionContext,
  maxCommits?: number,
  skip = 0,
  branch?: string,
): Promise<string | undefined> {
  const { parseGitLog } = await import("./git-log-parser.ts");
  const settings = context ? getSettings(context) : DEFAULT_SETTINGS;
  let requests = commitRequests.get(panel);
  if (!requests) {
    requests = { latest: 0, lastReset: 0 };
    commitRequests.set(panel, requests);
  }
  // A re-read the host starts by itself asks for as many commits as the panel has paged
  // in: the first page alone would take the rest from under the reader.
  const window = { maxCommits: maxCommits ?? Math.max(settings.maxCommits, requests.shown ?? 0), skip, branch,
    firstParentOnly: settings.firstParentOnly, ordering: settings.commitOrdering };
  let generation = beginCommitRequest(requests, skip);

  const format = `--format=%H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%D%n%s%n<END_COMMIT>`;
  let result = await spawnGit(vscode, logArgs(window, format), projectPath);
  // A filter on a branch that is gone — renamed, deleted, pruned by a fetch — fails the
  // log. That is not an empty history: every branch is read from the top instead, which
  // replaces the list, and the answer says "all" so the picker stops naming the branch.
  if (result.exitCode !== 0 && window.branch && window.branch !== "all" && !isStaleCommitRequest(requests, generation)) {
    window.branch = undefined;
    window.skip = 0;
    generation = beginCommitRequest(requests, 0);
    result = await spawnGit(vscode, logArgs(window, format), projectPath);
  }
  if (isStaleCommitRequest(requests, generation)) return undefined;
  const commits = parseGitLog(result.stdout);
  const shown = window.branch ?? "all";

  await panel.webview.postMessage({
    command: "loadCommits",
    data: commits,
    append: window.skip > 0,
    // Where a page goes: the panel drops one that does not continue the list it holds.
    skip: window.skip,
    // Which window this is, so a list the host refreshed by itself keeps the
    // branch picker saying what is on screen.
    scope: shown,
  });
  requests.shown = window.skip + commits.length;

  // Lines changed, in a second pass. Asking the first log for --shortstat makes
  // git diff every commit in the window, and that cost would land before the
  // graph could be drawn at all; this way the numbers fill into their column a
  // moment after the rows are already on screen.
  try {
    const { parseShortstat } = await import("./shortstat-parser.ts");
    const stats = await spawnGit(vscode, logArgs(window, "--format=%H", "--shortstat"), projectPath);
    if (isStaleCommitRequest(requests, generation)) return shown;
    await panel.webview.postMessage({
      command: "loadCommitStats",
      data: parseShortstat(stats.stdout),
    });
  } catch {
    // A column of numbers is not worth an error banner over the graph.
  }
  return shown;
}

export interface LogWindow {
  maxCommits: number;
  skip: number;
  branch?: string;
  firstParentOnly?: boolean;
  ordering?: string;
}

/**
 * The commit window, as git arguments.
 *
 * Shared so the stats pass sees exactly the same commits as the graph: the two
 * are joined by hash, so a different window would silently leave rows blank.
 * Exported for its own test — the branch in it comes from a webview.
 */
export function logArgs(window: LogWindow, ...format: string[]): string[] {
  const orderFlag = window.ordering === "date" ? "--date-order"
    : window.ordering === "author-date" ? "--author-date-order"
    : "--topo-order";
  const args = ["log", ...format, orderFlag, "-n", String(window.maxCommits)];
  if (window.firstParentOnly) args.push("--first-parent");
  if (window.skip > 0) args.push(`--skip=${window.skip}`);
  if (window.branch && window.branch !== "all") {
    // The branch came from a webview. git happens to reject a dash-leading
    // refname on its own, but that is a coincidence rather than a design, and
    // this window is now spawned twice per request — once for the graph and
    // once for the stats — so the value reaches git on two paths.
    // `--`: a branch that no longer exists is an error, not the history of a path of that name.
    args.push(assertValidRef(window.branch, "branch"), "--");
  } else {
    // Exclude stash refs — stashes are loaded separately via handleStashes
    args.push("--exclude=refs/stash", "--all");
  }
  return args;
}

async function handleCommitDetails(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
  rawHash: string,
): Promise<void> {
  const hash = assertValidHash(rawHash);
  const result = await spawnGit(vscode, ["show", "--numstat", "--summary", DETAIL_FORMAT, hash], projectPath);

  const detail = parseCommitDetail(result.stdout);
  await panel.webview.postMessage({ command: "commitDetails", data: detail });
}

/**
 * A stash, as the inspector shows a commit: its message, and what it changed
 * against the commit it was made on.
 *
 * Not `git show`: a stash is a merge of its base and its index, and the
 * combined diff `show` prints for a merge leaves out every file whose staged
 * state was stashed unchanged — the file matches one parent, so it is not
 * "different from all of them". The diff against the first parent is what was
 * stashed, and the third parent, when there is one, holds the untracked files.
 */
async function handleStashDetails(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
  rawHash: string,
): Promise<void> {
  const hash = assertValidHash(rawHash);
  const header = await spawnGit(vscode, ["show", "-s", DETAIL_FORMAT, hash], projectPath);
  if (header.exitCode !== 0) throw new Error(header.stderr.trim() || "git could not read that stash.");
  const parents = (header.stdout.split("\n")[1] || "").split(" ").filter(Boolean);
  const [tracked, untracked] = await Promise.all([
    spawnGit(vscode, ["diff", "--numstat", "--summary", `${hash}^1`, hash], projectPath),
    parents.length > 2
      ? spawnGit(vscode, ["show", "--numstat", "--summary", "--format=", `${hash}^3`], projectPath)
      : Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  ]);
  const detail = parseCommitDetail(`${header.stdout.trimEnd()}\n${tracked.stdout}\n${untracked.stdout}`);
  await panel.webview.postMessage({ command: "commitDetails", data: detail });
}

/**
 * Switch PPM to the project living at `path`, offering to register it first.
 *
 * A worktree or a submodule is a git repository PPM may never have been told
 * about; without this, opening one would silently do nothing.
 */
async function openProjectAt(vscode: VscodeApi, path: string, kind: string): Promise<void> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/projects`, authHeaders());
    const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
    const match = json.data?.find((p) => p.path === path);
    if (match) {
      await vscode.window.switchProject(match.name);
      return;
    }

    const dirName = path.split(/[\\/]/).filter(Boolean).pop() || kind.toLowerCase();
    const answer = await vscode.window.showInformationMessage(
      `${kind} "${dirName}" is not registered as a project. Add it?`,
      "Yes, add project", "Cancel",
    );
    if (answer !== "Yes, add project") return;

    const authInit = authHeaders() as { headers?: Record<string, string> };
    const addRes = await fetch(`${getBaseUrl()}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authInit.headers ?? {}) },
      body: JSON.stringify({ path, name: dirName }),
    });
    const addJson = await addRes.json() as { ok: boolean; data?: { name: string } };
    if (addJson.ok) {
      await vscode.window.switchProject(addJson.data?.name || dirName);
    } else {
      await vscode.window.showErrorMessage("Failed to add project");
    }
  } catch {
    await vscode.window.showErrorMessage("Failed to look up projects");
  }
}

/**
 * The repository's submodules and how far each has drifted.
 *
 * A repository with no submodules is the overwhelming majority, and git exits
 * non-zero for one reason or another in several of the edge cases, so a failure
 * here reports an empty list rather than an error the user cannot act on.
 */
async function handleSubmodules(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
): Promise<void> {
  const result = await spawnGit(vscode, ["submodule", "status", "--recursive"], projectPath, 30_000);
  await panel.webview.postMessage({
    command: "loadSubmodules",
    data: result.exitCode === 0 ? parseSubmoduleStatus(result.stdout) : [],
  });
}

async function handleWorktrees(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
): Promise<void> {
  const result = await spawnGit(vscode, ["worktree", "list", "--porcelain"], projectPath, 10_000);
  if (result.exitCode !== 0) {
    await panel.webview.postMessage({ command: "loadWorktrees", data: [] });
    return;
  }
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as Worktree);
      current = { path: line.slice(9), branch: "", head: "", isMain: false, isDetached: false, locked: false, prunable: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.isDetached = true;
    } else if (line === "bare") {
      // skip bare entries
    } else if (line.startsWith("locked")) {
      current.locked = true;
      if (line.length > 7) current.lockReason = line.slice(7);
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  if (current.path) worktrees.push(current as Worktree);
  // Mark first worktree as main
  if (worktrees.length > 0) worktrees[0].isMain = true;
  await panel.webview.postMessage({ command: "loadWorktrees", data: worktrees });
}

async function handleStashes(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
): Promise<void> {
  const result = await spawnGit(vscode, ["stash", "list", `--format=${STASH_FORMAT}`], projectPath, 10_000);
  const stashes = result.exitCode === 0 ? parseStashes(result.stdout) : [];
  await panel.webview.postMessage({ command: "loadStashes", data: stashes });
}

/**
 * One git command from the panel's menus, answered exactly once.
 *
 * A refused argument is answered like a failed command, because the button
 * that asked is waiting on this action's answer. The re-read runs either way:
 * a merge or a rebase that stops on a conflict has moved things all the same.
 */
async function handleGitAction(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
  action: string,
  args: Record<string, unknown>,
  refresh: () => Promise<void>,
  reqId?: number,
): Promise<void> {
  let result: { ok: boolean; error?: string };
  try {
    const gitArgs = buildGitActionArgs(action, args);
    if (action === "stashBranch") await assertStashUnchanged(vscode, projectPath, args.index, args.hash);
    const res = await spawnGit(vscode, gitArgs, projectPath);
    result = res.exitCode === 0
      ? { ok: true }
      : { ok: false, error: res.stderr.trim() || `git exited with ${res.exitCode}` };
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  await panel.webview.postMessage({ command: "actionResult", action, args, result, reqId });
  await refresh();
}

/** `stash@{n}` for an index from the panel. */
function stashRef(index: unknown): string {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid stash index: "${String(index)}"`);
  }
  return `stash@{${index}}`;
}

/**
 * A stash is named by its position, and positions shift as stashes come and
 * go — so act only if the position still holds the stash the panel showed.
 * Same check, same words, as PPM's own stash routes.
 */
async function assertStashUnchanged(vscode: VscodeApi, projectPath: string, index: unknown, hash: unknown): Promise<void> {
  const res = await spawnGit(vscode, ["rev-parse", "--verify", "-q", stashRef(index)], projectPath);
  if (typeof hash !== "string" || !hash || res.stdout.trim() !== hash) {
    throw new Error("The stash list changed. Reload it and try again.");
  }
}

// --- Parsers ---

/**
 * A symbolic ref (`%(symref)` set) is skipped: `refs/remotes/origin/HEAD` only points at the
 * remote's default branch, and `refname:short` shortens it to the bare remote name, so it was
 * listed as a local branch called "origin".
 */
export function parseBranches(stdout: string): import("./types.ts").Branch[] {
  return stdout.trim().split("\n").filter(Boolean).flatMap((line) => {
    const [name, hash, head, symref] = line.split("|");
    if (symref) return [];
    const remote = name.includes("/") ? name.split("/")[0] : undefined;
    return [{ name, hash, current: head === "*", remote }];
  });
}

function parseTags(stdout: string): import("./types.ts").Tag[] {
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, hash] = line.split("|");
    return { name, hash };
  });
}

function parseRemotes(stdout: string): import("./types.ts").Remote[] {
  const map = new Map<string, { fetchUrl: string; pushUrl: string }>();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
    if (!match) continue;
    const [, name, url, type] = match;
    if (!map.has(name)) map.set(name, { fetchUrl: "", pushUrl: "" });
    const entry = map.get(name)!;
    if (type === "fetch") entry.fetchUrl = url;
    else entry.pushUrl = url;
  }
  return [...map.entries()].map(([name, urls]) => ({ name, ...urls }));
}

/** Fields split by the unit separator: a name or a message may hold any printable character. */
export const STASH_FORMAT = "%H%x1f%P%x1f%at%x1f%an%x1f%ae%x1f%s";

export function parseStashes(stdout: string): import("./types.ts").Stash[] {
  return stdout.trim().split("\n").filter(Boolean).map((line, i) => {
    const [hash = "", parents = "", date = "", author = "", authorEmail = "", ...message] = line.split("\x1f");
    // The first parent is the commit the stash was made on.
    const parentHash = parents.split(" ")[0] || "";
    return { index: i, hash, parentHash, message: message.join("\x1f"), author, authorEmail, date: Number(date) || 0 };
  });
}

/**
 * Files listed for one commit. The uncommitted-status handler two functions
 * away already caps at the same number; this one capped at nothing, and a
 * commit touching ten thousand files became ten thousand objects across
 * `postMessage` and ten thousand rows in one `innerHTML`. A repository you
 * clone can ship that commit.
 *
 * The cap has to be *said*, not just applied: a truncated list rendered as
 * "500 files changed" is a wrong number presented as a fact, which is worse
 * than a slow panel. `filesOmitted` carries what was dropped, the way the
 * message cap appends its own `[… N more characters]`.
 */
export const MAX_DETAIL_FILES = 500;

/**
 * Characters of commit message the panel will render.
 *
 * `%B` is whatever the author wrote and is not bounded by anything — and the
 * message then goes through the issue-link matcher, whose span-overlap check is
 * quadratic in the number of matches. `\b[0-9a-f]{7,40}\b` matches once per
 * hex-looking word, so a body of them is ~n² comparisons. 100 KB is longer than
 * any message anyone reads and short enough that the worst case stays cheap.
 */
const MAX_MESSAGE_CHARS = 100_000;

/** The header `parseCommitDetail` reads, ahead of the `--numstat --summary` lines. */
export const DETAIL_FORMAT = "--format=%H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%B%n<END_MSG>";

export function parseCommitDetail(stdout: string): import("./types.ts").CommitDetail {
  const [headerBlock, rest] = stdout.split("<END_MSG>");
  const lines = headerBlock.trim().split("\n");
  const hash = lines[0];
  const parents = lines[1] ? lines[1].split(" ").filter(Boolean) : [];
  const author = lines[2];
  const authorEmail = lines[3];
  const authorDate = parseInt(lines[4], 10);
  const committer = lines[5];
  const committerEmail = lines[6];
  const commitDate = parseInt(lines[7], 10);
  const full = lines.slice(8).join("\n").trim();
  const message = full.length > MAX_MESSAGE_CHARS
    ? `${full.slice(0, MAX_MESSAGE_CHARS)}\n\n[… ${full.length - MAX_MESSAGE_CHARS} more characters]`
    : full;

  // `--summary` says which files were created or deleted; the line counts cannot.
  // A file that only gained lines is not a new file.
  const created = new Set<string>();
  const deleted = new Set<string>();
  for (const m of (rest ?? "").matchAll(/^ (create|delete) mode \d+ (.+)$/gm)) {
    (m[1] === "create" ? created : deleted).add(m[2]!);
  }

  // Parse --numstat output for file changes (format: "adds\tdels\tpath")
  const fileChanges: import("./types.ts").FileChange[] = [];
  let filesOmitted = 0;
  if (rest) {
    for (const line of rest.trim().split("\n").filter(Boolean)) {
      const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (numstatMatch) {
        // Past the cap the rest of the walk is only counting, so that the panel
        // can say how many files it is not showing.
        if (fileChanges.length >= MAX_DETAIL_FILES) {
          filesOmitted++;
          continue;
        }
        const additions = numstatMatch[1] === "-" ? 0 : parseInt(numstatMatch[1], 10);
        const deletions = numstatMatch[2] === "-" ? 0 : parseInt(numstatMatch[2], 10);
        let filePath = numstatMatch[3];
        let oldPath: string | undefined;
        // Renamed files: "old => new" or "{prefix/old => prefix/new}"
        const renameMatch = filePath.match(/^(.+)\{(.+) => (.+)\}(.*)$/) || filePath.match(/^(.+) => (.+)$/);
        let status: "A" | "M" | "D" | "R" = created.has(filePath) ? "A" : deleted.has(filePath) ? "D" : "M";
        if (renameMatch) {
          status = "R";
          if (renameMatch.length === 5) {
            oldPath = renameMatch[1] + renameMatch[2] + renameMatch[4];
            filePath = renameMatch[1] + renameMatch[3] + renameMatch[4];
          } else {
            oldPath = renameMatch[1];
            filePath = renameMatch[2];
          }
        }
        fileChanges.push({ path: filePath, oldPath, status, additions, deletions });
      }
    }
  }

  return { hash, parents, author, authorEmail, authorDate, committer, committerEmail, commitDate, message, fileChanges, filesOmitted };
}

/** The git command behind each menu action the panel can send — and nothing else. */
function buildGitActionArgs(action: string, args: Record<string, unknown>): string[] {
  const VALID_RESET_MODES = ["soft", "mixed", "hard"];

  switch (action) {
    // `--`: without it a name that is not a ref is read as a path when one exists, and git
    // quietly puts that path back as the index has it — a deleted branch's pill discarded
    // every edit under the folder of the same name.
    case "checkout": return ["checkout", assertValidRef(args.target, "target"), "--"];
    case "createBranch": return ["branch", ...(args.force ? ["-f"] : []), assertValidRef(args.name, "name"), ...(args.startPoint ? [assertValidHash(args.startPoint)] : [])];
    case "deleteBranch": return ["branch", args.force ? "-D" : "-d", assertValidRef(args.name, "name")];
    case "renameBranch": return ["branch", "-m", assertValidRef(args.oldName, "oldName"), assertValidRef(args.newName, "newName")];
    case "merge": return ["merge", assertValidRef(args.branch, "branch")];
    case "rebase": return ["rebase", assertValidRef(args.branch, "branch")];
    case "rebaseSkip": return ["rebase", "--skip"];
    case "cherryPick": return ["cherry-pick", assertValidHash(args.hash)];
    // Without --no-edit git opens an editor for the message, which nothing here
    // can answer — the command would sit until the spawn timed out.
    case "revert": return ["revert", "--no-edit", assertValidHash(args.hash)];
    case "reset": {
      const mode = VALID_RESET_MODES.includes(String(args.mode)) ? String(args.mode) : "mixed";
      return ["reset", `--${mode}`, assertValidHash(args.hash)];
    }
    case "stashBranch": return ["stash", "branch", assertValidRef(args.name, "name"), stashRef(args.index)];
    case "createTag": return ["tag", assertValidRef(args.name, "name"), ...(args.hash ? [assertValidHash(args.hash)] : [])];
    case "deleteTag": return ["tag", "-d", assertValidRef(args.name, "name")];
    case "push": {
      // Only deleting a remote branch: pushing and publishing go through PPM's own routes.
      if (!args.delete) throw new Error("Push from the toolbar instead.");
      return ["push", assertValidRemote(args.remote), "--delete", assertValidRef(args.branch, "branch")];
    }
    default: throw new Error(`Unknown git action: ${action}`);
  }
}
