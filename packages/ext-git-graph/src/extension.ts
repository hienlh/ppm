/**
 * @ppm/ext-git-graph — Git Graph extension for PPM.
 * Visualizes git commit history as an interactive graph in a webview.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { GitGraphSettings, WebviewToExt, Worktree } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import { getWebviewHtml } from "./webview-html.ts";
import type { VscodeApi } from "./git-exec.ts";
import {
  assertSafeFilePaths, assertValidHash, assertValidRef, assertValidRemote, spawnGit,
} from "./git-exec.ts";
import { authHeaders, getBaseUrl, initPpmApi, resolveProjectName } from "./ppm-api.ts";
import { registerBlameView } from "./blame-view.ts";
import { registerFileHistoryView } from "./file-history-view.ts";
import { registerCompareView } from "./compare-view.ts";
import { registerRebaseView } from "./rebase-view.ts";
import { registerReflogView } from "./reflog-view.ts";
import { parseSubmoduleStatus } from "./submodule-parser.ts";
import { openPanel } from "./panel-registry.ts";
import { detectMergeState } from "./git-state.ts";
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
]);

async function saveSetting(context: ExtensionContext, key: string, value: unknown): Promise<GitGraphSettings> {
  if (!VALID_SETTING_KEYS.has(key)) throw new Error(`Invalid setting key: ${key}`);
  const settings = getSettings(context);
  (settings as any)[key] = value;
  await context.globalState.update("settings", settings);
  return settings;
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
  let uncommittedPollTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const panel = openPanel({
    vscode,
    viewType: "git-graph.view",
    title: `Git Graph: ${dirName}`,
    projectPath,
    html: getWebviewHtml(),
    onDispose: () => {
      disposed = true;
      if (uncommittedPollTimer) clearInterval(uncommittedPollTimer);
    },
    onMessage: async (raw: unknown) => {
    const msg = raw as WebviewToExt;
    // Panel is bound to its project for life — reopening a project recreates
    // the panel, so the closure path is always current.
    const pp = projectPath;
    try {
      switch (msg.command) {
        case "ready":
          await handleRepoInfo(vscode, panel, pp);
          await handleRequestCommits(vscode, panel, pp, context);
          handleUncommittedStatus(vscode, panel, pp); // fire-and-forget
          handleWorktrees(vscode, panel, pp); // fire-and-forget
          handleStashes(vscode, panel, pp); // fire-and-forget
          handleSubmodules(vscode, panel, pp); // fire-and-forget
          break;
        case "requestRepoInfo":
          await handleRepoInfo(vscode, panel, pp);
          break;
        case "requestCommits":
          await handleRequestCommits(vscode, panel, pp, context, msg.maxCommits, msg.skip, msg.branch);
          break;
        case "requestCommitDetails":
          await handleCommitDetails(vscode, panel, pp, msg.hash);
          break;
        case "requestUncommitted":
          await handleUncommittedStatus(vscode, panel, pp);
          break;
        case "openDiff": {
          assertSafeFilePaths([msg.filePath], pp);
          const fileName = msg.filePath.split(/[\\/]/).pop() || msg.filePath;
          const projectName = await resolveProjectName(pp);
          await vscode.window.openTab("git-diff", `${fileName} (${msg.hash.substring(0, 7)})`, projectName, {
            projectName,
            filePath: msg.filePath,
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
            await handleRequestCommits(vscode, panel, pp, context, updated.maxCommits);
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
          if (msg.args?.files && Array.isArray(msg.args.files)) {
            assertSafeFilePaths(msg.args.files as string[], pp);
          }
          if (msg.action === "discard") {
            await handleDiscard(vscode, panel, pp, context, msg.args);
          } else {
            await handleGitAction(vscode, panel, pp, context, msg.action, msg.args);
          }
          break;
        case "openFile": {
          assertSafeFilePaths([msg.filePath], pp);
          const projectName = await resolveProjectName(pp);
          await vscode.window.openTab("editor", msg.filePath, projectName, {
            projectName,
            filePath: msg.filePath,
          });
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
        case "updateSubmodule": {
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
          await handleSubmodules(vscode, panel, pp);
          break;
        }
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
        case "openInteractiveRebase":
          await navigateToPanel({
            vscode,
            context,
            viewType: "git-graph.interactiveRebase",
            title: "Interactive Rebase",
            projectPath: pp,
            target: msg.base ? { base: assertValidHash(msg.base) } : undefined,
          });
          break;
        case "addWorktree": {
          const addArgs = ["worktree", "add"];
          if (msg.newBranch) {
            addArgs.push("-b", assertValidRef(msg.newBranch, "newBranch"));
          }
          addArgs.push(msg.path);
          if (msg.branch) addArgs.push(assertValidRef(msg.branch, "branch"));
          if (msg.startPoint) addArgs.push(assertValidHash(msg.startPoint));
          const addResult = await spawnGit(vscode, addArgs, pp);
          await panel.webview.postMessage({
            command: "actionResult", action: "addWorktree",
            result: { ok: addResult.exitCode === 0, error: addResult.exitCode !== 0 ? addResult.stderr.trim() : undefined },
          });
          if (addResult.exitCode === 0) await handleWorktrees(vscode, panel, pp);
          break;
        }
        case "removeWorktree": {
          const rmArgs = ["worktree", "remove", ...(msg.force ? ["--force"] : []), msg.path];
          const rmResult = await spawnGit(vscode, rmArgs, pp);
          await panel.webview.postMessage({
            command: "actionResult", action: "removeWorktree",
            result: { ok: rmResult.exitCode === 0, error: rmResult.exitCode !== 0 ? rmResult.stderr.trim() : undefined },
          });
          if (rmResult.exitCode === 0) await handleWorktrees(vscode, panel, pp);
          break;
        }
        case "pruneWorktrees": {
          const pruneResult = await spawnGit(vscode, ["worktree", "prune"], pp);
          await panel.webview.postMessage({
            command: "actionResult", action: "pruneWorktrees",
            result: { ok: pruneResult.exitCode === 0, error: pruneResult.exitCode !== 0 ? pruneResult.stderr.trim() : undefined },
          });
          if (pruneResult.exitCode === 0) await handleWorktrees(vscode, panel, pp);
          break;
        }
        case "openWorktree":
          await openProjectAt(vscode, msg.path, "Worktree");
          break;
        case "openConflictFile": {
          assertSafeFilePaths([msg.filePath], pp);
          const projectName = await resolveProjectName(pp);
          // Opens as conflict-editor tab (Phase 4 will wire this properly)
          await vscode.window.openTab("conflict-editor", `Conflict: ${msg.filePath.split(/[\\/]/).pop()}`, projectName, {
            projectName,
            filePath: msg.filePath,
          });
          break;
        }
        case "openSourceControl": {
          await vscode.window.showInformationMessage("Open the Source Control panel from the sidebar.");
          break;
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await panel.webview.postMessage({ command: "error", message: errMsg });
    }
    },
  });

  // Poll uncommitted changes every 5 seconds
  uncommittedPollTimer = setInterval(() => {
    if (!disposed) handleUncommittedStatus(vscode, panel, projectPath);
  }, 5_000);
}


async function handleRepoInfo(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
): Promise<void> {
  const [branchResult, tagResult, remoteResult, stashResult, headResult, headHashResult] = await Promise.all([
    spawnGit(vscode, ["branch", "-a", "--format=%(refname:short)|%(objectname:short)|%(HEAD)"], projectPath),
    spawnGit(vscode, ["tag", "-l", "--format=%(refname:short)|%(objectname:short)"], projectPath),
    spawnGit(vscode, ["remote", "-v"], projectPath),
    spawnGit(vscode, ["stash", "list", "--format=%gd|%H|%P|%s"], projectPath),
    spawnGit(vscode, ["rev-parse", "--abbrev-ref", "HEAD"], projectPath),
    spawnGit(vscode, ["rev-parse", "HEAD"], projectPath),
  ]);

  const branches = parseBranches(branchResult.stdout);
  const tags = parseTags(tagResult.stdout);
  const remotes = parseRemotes(remoteResult.stdout);
  const stashes = parseStashes(stashResult.stdout);
  const currentBranch = headResult.stdout.trim();
  const headHash = headHashResult.stdout.trim();

  await panel.webview.postMessage({
    command: "loadRepoInfo",
    data: { path: projectPath, branches, tags, remotes, stashes, head: headHash, currentBranch },
  });
}

async function handleRequestCommits(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
  context?: ExtensionContext,
  maxCommits = 300,
  skip = 0,
  branch?: string,
): Promise<void> {
  const { parseGitLog } = await import("./git-log-parser.ts");
  const settings = context ? getSettings(context) : DEFAULT_SETTINGS;
  const orderFlag = settings.commitOrdering === "date" ? "--date-order"
    : settings.commitOrdering === "author-date" ? "--author-date-order"
    : "--topo-order";
  const args = [
    "log",
    `--format=%H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%D%n%s%n<END_COMMIT>`,
    orderFlag,
    `-n`, String(maxCommits),
  ];
  if (settings.firstParentOnly) args.push("--first-parent");
  if (skip > 0) args.push(`--skip=${skip}`);
  if (branch && branch !== "all") {
    args.push(branch);
  } else {
    // Exclude stash refs — stashes are loaded separately via handleStashes
    args.push("--exclude=refs/stash", "--all");
  }

  const result = await spawnGit(vscode, args, projectPath);
  const commits = parseGitLog(result.stdout);

  await panel.webview.postMessage({
    command: "loadCommits",
    data: commits,
    append: skip > 0,
  });
}

async function handleCommitDetails(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
  hash: string,
): Promise<void> {
  const result = await spawnGit(vscode, [
    "show", "--numstat", "--format=%H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%B%n<END_MSG>", hash,
  ], projectPath);

  const detail = parseCommitDetail(result.stdout);
  await panel.webview.postMessage({ command: "commitDetails", data: detail });
}

const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

async function handleUncommittedStatus(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
): Promise<void> {
  try {
    const result = await spawnGit(vscode, ["status", "--porcelain=v1", "-u"], projectPath, 10_000);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      await panel.webview.postMessage({ command: "loadUncommitted", data: null });
      return;
    }
    const staged: import("./types.ts").FileChange[] = [];
    const unstaged: import("./types.ts").FileChange[] = [];
    const conflicted: import("./types.ts").FileChange[] = [];
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      if (staged.length + unstaged.length + conflicted.length >= 500) break;
      const xy = line.substring(0, 2);
      const filePath = line.substring(3);

      // Check for unmerged/conflict entries first
      if (UNMERGED_CODES.has(xy)) {
        conflicted.push({ path: filePath, status: "U", additions: 0, deletions: 0 });
        continue;
      }

      const x = xy[0]; // staged status
      const y = xy[1]; // unstaged status
      if (x !== " " && x !== "?") {
        staged.push({ path: filePath, status: mapStatusCode(x), additions: 0, deletions: 0 });
      }
      if (y !== " " && y !== "?") {
        unstaged.push({ path: filePath, status: mapStatusCode(y), additions: 0, deletions: 0 });
      }
      if (x === "?" && y === "?") {
        unstaged.push({ path: filePath, status: "A", additions: 0, deletions: 0 });
      }
    }

    // Only detect merge state when conflicts exist (perf optimization)
    let mergeState: import("./types.ts").MergeState | undefined;
    if (conflicted.length > 0) {
      mergeState = await detectMergeState(vscode, projectPath);
    }

    await panel.webview.postMessage({
      command: "loadUncommitted",
      data: { staged, unstaged, conflicted, mergeState },
    });
  } catch {
    await panel.webview.postMessage({ command: "loadUncommitted", data: null });
  }
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
  const result = await spawnGit(vscode, ["stash", "list", "--format=%gd|%H|%P|%s"], projectPath, 10_000);
  const stashes: import("./types.ts").Stash[] = [];
  if (result.exitCode === 0 && result.stdout.trim()) {
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const parts = line.split("|");
      if (parts.length >= 4) {
        const refMatch = parts[0].match(/\{(\d+)\}/);
        // %P gives space-separated parent hashes; first parent is the commit the stash was created on
        const parentHash = parts[2].split(" ")[0] || "";
        stashes.push({
          index: refMatch ? parseInt(refMatch[1]) : stashes.length,
          hash: parts[1],
          parentHash,
          message: parts.slice(3).join("|"),
        });
      }
    }
  }
  await panel.webview.postMessage({ command: "loadStashes", data: stashes });
}

function mapStatusCode(code: string): "A" | "M" | "D" | "R" {
  if (code === "A" || code === "?") return "A";
  if (code === "D") return "D";
  if (code === "R") return "R";
  return "M";
}

async function handleGitAction(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
  context: ExtensionContext,
  action: string,
  args: Record<string, unknown>,
): Promise<void> {
  const gitArgs = buildGitActionArgs(action, args);
  const result = await spawnGit(vscode, gitArgs, projectPath);
  const ok = result.exitCode === 0;

  await panel.webview.postMessage({
    command: "actionResult",
    action,
    args,
    result: { ok, error: ok ? undefined : result.stderr.trim() },
  });

  // Refresh after action
  if (ok) {
    await handleRepoInfo(vscode, panel, projectPath);
    await handleRequestCommits(vscode, panel, projectPath, context);
    handleUncommittedStatus(vscode, panel, projectPath); // fire-and-forget
  }
}

async function handleDiscard(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
  context: ExtensionContext,
  args: Record<string, unknown>,
): Promise<void> {
  const files = (args.files as string[] | undefined) || [];
  if (!files.length) throw new Error("No files to discard");

  // Determine tracked vs untracked
  const statusResult = await spawnGit(vscode, ["status", "--porcelain=v1"], projectPath, 10_000);
  const untracked = new Set<string>();
  for (const line of statusResult.stdout.split("\n").filter(Boolean)) {
    if (line.startsWith("??")) untracked.add(line.substring(3).trim());
  }

  const trackedFiles = files.filter((f) => !untracked.has(f));
  const untrackedFiles = files.filter((f) => untracked.has(f));
  const errors: string[] = [];

  if (trackedFiles.length > 0) {
    const r = await spawnGit(vscode, ["checkout", "--", ...trackedFiles], projectPath);
    if (r.exitCode !== 0) errors.push(r.stderr.trim());
  }
  if (untrackedFiles.length > 0) {
    const r = await spawnGit(vscode, ["clean", "-f", "--", ...untrackedFiles], projectPath);
    if (r.exitCode !== 0) errors.push(r.stderr.trim());
  }

  const ok = errors.length === 0;
  await panel.webview.postMessage({
    command: "actionResult",
    action: "discard",
    result: { ok, error: ok ? undefined : errors.join("; ") },
  });

  // Always refresh to show current state (even on partial failure some files may have been discarded)
  await handleRepoInfo(vscode, panel, projectPath);
  await handleRequestCommits(vscode, panel, projectPath, context);
  handleUncommittedStatus(vscode, panel, projectPath);
}

// --- Parsers ---

function parseBranches(stdout: string): import("./types.ts").Branch[] {
  return stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [name, hash, head] = line.split("|");
    const remote = name.includes("/") ? name.split("/")[0] : undefined;
    return { name, hash, current: head === "*", remote };
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

function parseStashes(stdout: string): import("./types.ts").Stash[] {
  return stdout.trim().split("\n").filter(Boolean).map((line, i) => {
    const parts = line.split("|");
    const [, hash, parents, ...messageParts] = parts;
    const parentHash = (parents || "").split(" ")[0] || "";
    return { index: i, hash, parentHash, message: messageParts.join("|") };
  });
}

function parseCommitDetail(stdout: string): import("./types.ts").CommitDetail {
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
  const message = lines.slice(8).join("\n").trim();

  // Parse --numstat output for file changes (format: "adds\tdels\tpath")
  const fileChanges: import("./types.ts").FileChange[] = [];
  if (rest) {
    for (const line of rest.trim().split("\n").filter(Boolean)) {
      const numstatMatch = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (numstatMatch) {
        const additions = numstatMatch[1] === "-" ? 0 : parseInt(numstatMatch[1], 10);
        const deletions = numstatMatch[2] === "-" ? 0 : parseInt(numstatMatch[2], 10);
        let filePath = numstatMatch[3];
        let oldPath: string | undefined;
        // Renamed files: "old => new" or "{prefix/old => prefix/new}"
        const renameMatch = filePath.match(/^(.+)\{(.+) => (.+)\}(.*)$/) || filePath.match(/^(.+) => (.+)$/);
        let status: "A" | "M" | "D" | "R" = "M";
        if (renameMatch) {
          status = "R";
          if (renameMatch.length === 5) {
            oldPath = renameMatch[1] + renameMatch[2] + renameMatch[4];
            filePath = renameMatch[1] + renameMatch[3] + renameMatch[4];
          } else {
            oldPath = renameMatch[1];
            filePath = renameMatch[2];
          }
        } else if (additions > 0 && deletions === 0) {
          status = "A";
        } else if (deletions > 0 && additions === 0) {
          status = "D";
        }
        fileChanges.push({ path: filePath, oldPath, status, additions, deletions });
      }
    }
  }

  return { hash, parents, author, authorEmail, authorDate, committer, committerEmail, commitDate, message, fileChanges };
}

function buildGitActionArgs(action: string, args: Record<string, unknown>): string[] {
  const VALID_RESET_MODES = ["soft", "mixed", "hard"];

  switch (action) {
    case "checkout": return ["checkout", assertValidRef(args.target, "target")];
    case "createBranch": return ["branch", ...(args.force ? ["-f"] : []), assertValidRef(args.name, "name"), ...(args.startPoint ? [assertValidHash(args.startPoint)] : [])];
    case "deleteBranch": return ["branch", args.force ? "-D" : "-d", assertValidRef(args.name, "name")];
    case "merge": {
      const mergeArgs = ["merge", assertValidRef(args.branch, "branch")];
      if (args.noFf) mergeArgs.push("--no-ff");
      if (args.squash) mergeArgs.push("--squash");
      return mergeArgs;
    }
    case "rebase": return ["rebase", assertValidRef(args.branch, "branch")];
    case "cherryPick": return ["cherry-pick", assertValidHash(args.hash)];
    case "revert": return ["revert", assertValidHash(args.hash)];
    case "reset": {
      const mode = VALID_RESET_MODES.includes(String(args.mode)) ? String(args.mode) : "mixed";
      return ["reset", `--${mode}`, assertValidHash(args.hash)];
    }
    case "stashSave": return ["stash", "push", ...(args.message ? ["-m", String(args.message)] : [])];
    case "stashPop": return ["stash", "pop", ...(args.stashRef ? [assertValidRef(args.stashRef, "stashRef")] : [])];
    case "stashDrop": return ["stash", "drop", ...(args.stashRef ? [assertValidRef(args.stashRef, "stashRef")] : [])];
    case "stashApply": return ["stash", "apply", ...(args.stashRef ? [assertValidRef(args.stashRef, "stashRef")] : [])];
    case "rebaseContinue": return ["rebase", "--continue"];
    case "rebaseAbort": return ["rebase", "--abort"];
    case "rebaseSkip": return ["rebase", "--skip"];
    case "mergeAbort": return ["merge", "--abort"];
    case "cherryPickAbort": return ["cherry-pick", "--abort"];
    case "cherryPickContinue": return ["cherry-pick", "--continue"];
    case "fetch": return ["fetch", ...(args.remote ? [assertValidRemote(args.remote)] : []), ...(args.prune ? ["--prune"] : [])];
    case "pull": return ["pull", ...(args.remote ? [assertValidRemote(args.remote)] : []), ...(args.branch ? [assertValidRef(args.branch, "branch")] : [])];
    case "renameBranch": {
      const oldName = assertValidRef(args.oldName, "oldName");
      const newName = assertValidRef(args.newName, "newName");
      return ["branch", "-m", oldName, newName];
    }
    case "push": {
      const pushArgs = ["push"];
      if (args.remote) pushArgs.push(assertValidRemote(args.remote));
      if (args.delete && args.branch) {
        pushArgs.push("--delete", assertValidRef(args.branch, "branch"));
      } else {
        if (args.branch) pushArgs.push(assertValidRef(args.branch, "branch"));
        if (args.force) pushArgs.push("--force");
      }
      return pushArgs;
    }
    case "createTag": {
      const tagArgs = ["tag", assertValidRef(args.name, "name")];
      if (args.hash) tagArgs.push(assertValidHash(args.hash));
      if (args.message) tagArgs.push("-m", String(args.message));
      return tagArgs;
    }
    case "deleteTag": return ["tag", "-d", assertValidRef(args.name, "name")];
    case "stage": {
      const files = args.files as string[] | undefined;
      if (!files?.length) throw new Error("No files to stage");
      return ["add", "--", ...files];
    }
    case "unstage": {
      const files = args.files as string[] | undefined;
      if (!files?.length) throw new Error("No files to unstage");
      return ["restore", "--staged", "--", ...files];
    }
    case "commit": {
      const message = String(args.message || "").trim();
      if (!message) throw new Error("Commit message required");
      return ["commit", "-m", message];
    }
    case "clean": return ["clean", "-fd"];
    default: throw new Error(`Unknown git action: ${action}`);
  }
}
