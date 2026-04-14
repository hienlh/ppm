/**
 * @ppm/ext-git-graph — Git Graph extension for PPM.
 * Visualizes git commit history as an interactive graph in a webview.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { SpawnResult } from "@ppm/vscode-compat/src/process.ts";
import type { GitGraphSettings, WebviewToExt } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import { getWebviewHtml } from "./webview-html.ts";

interface VscodeApi {
  commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void };
  };
  window: {
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
    openTab(tabType: string, title: string, projectId: string | null, metadata?: Record<string, unknown>): Promise<void>;
    createWebviewPanel(viewType: string, title: string, showOptions: unknown): {
      webview: {
        html: string;
        onDidReceiveMessage: (listener: (msg: unknown) => void) => { dispose(): void };
        postMessage(message: unknown): Promise<boolean>;
      };
      onDidDispose: (listener: () => void) => { dispose(): void };
      dispose(): void;
    };
  };
  process: {
    spawn(cmd: string, args: string[], cwd: string, options?: { timeout?: number; env?: Record<string, string> }): Promise<SpawnResult>;
  };
  ViewColumn: { Active: number };
}

let baseUrl = "";

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
  baseUrl = (globalThis as any).__PPM_BASE_URL__ || "";

  context.subscriptions.push(
    vscode.commands.registerCommand("git-graph.view", async (...args: unknown[]) => {
      const projectPath = args[0] as string | undefined;
      const resolvedPath = projectPath || await resolveProjectPath();
      if (!resolvedPath) {
        await vscode.window.showErrorMessage("Git Graph: No project selected. Open a project first, then try again.");
        return;
      }
      await openGitGraph(vscode, context, resolvedPath);
    }),
  );

  console.log("[ext-git-graph] activated");
}

export function deactivate(): void {
  console.log("[ext-git-graph] deactivated");
}

/** Resolve project path from PPM API as fallback */
async function resolveProjectPath(): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/projects`);
    const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
    if (!json.ok || !json.data || json.data.length === 0) return null;
    // Single project — safe to auto-select
    if (json.data.length === 1) return json.data[0].path;
    // Multiple projects — cannot guess which is active, return null
    return null;
  } catch {}
  return null;
}

/** Resolve project name from path via PPM API */
async function resolveProjectName(projectPath: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/api/projects`);
    const json = await res.json() as { ok: boolean; data?: { name: string; path: string }[] };
    if (json.ok && json.data) {
      const match = json.data.find((p) => p.path === projectPath);
      if (match) return match.name;
    }
  } catch {}
  // Fallback to directory name
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || "project";
}

/** Spawn git and return result */
async function spawnGit(
  vscode: VscodeApi,
  args: string[],
  cwd: string,
  timeout = 30_000,
): Promise<SpawnResult> {
  return vscode.process.spawn("git", args, cwd, {
    timeout,
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
}

function openGitGraph(
  vscode: VscodeApi,
  context: ExtensionContext,
  projectPath: string,
): void {
  const dirName = projectPath.split(/[\\/]/).filter(Boolean).pop() || "Git Graph";
  const panel = vscode.window.createWebviewPanel(
    "git-graph.view",
    `Git Graph: ${dirName}`,
    vscode.ViewColumn.Active,
  );

  panel.webview.html = getWebviewHtml();

  const msgDisposable = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const msg = raw as WebviewToExt;
    try {
      switch (msg.command) {
        case "ready":
          await handleRepoInfo(vscode, panel, projectPath);
          await handleRequestCommits(vscode, panel, projectPath, context);
          handleUncommittedStatus(vscode, panel, projectPath); // fire-and-forget
          break;
        case "requestRepoInfo":
          await handleRepoInfo(vscode, panel, projectPath);
          break;
        case "requestCommits":
          await handleRequestCommits(vscode, panel, projectPath, context, msg.maxCommits, msg.skip, msg.branch);
          break;
        case "requestCommitDetails":
          await handleCommitDetails(vscode, panel, projectPath, msg.hash);
          break;
        case "requestUncommitted":
          await handleUncommittedStatus(vscode, panel, projectPath);
          break;
        case "openDiff": {
          assertSafeFilePaths([msg.filePath], projectPath);
          const fileName = msg.filePath.split(/[\\/]/).pop() || msg.filePath;
          const projectName = await resolveProjectName(projectPath);
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
            await handleRequestCommits(vscode, panel, projectPath, context, updated.maxCommits);
          }
          break;
        }
        case "requestUserDetails": {
          const [nameResult, emailResult] = await Promise.all([
            spawnGit(vscode, ["config", "user.name"], projectPath),
            spawnGit(vscode, ["config", "user.email"], projectPath),
          ]);
          await panel.webview.postMessage({
            command: "loadUserDetails",
            data: { name: nameResult.stdout.trim(), email: emailResult.stdout.trim() },
          });
          break;
        }
        case "updateUserDetails": {
          if (msg.name !== undefined) await spawnGit(vscode, ["config", "user.name", msg.name], projectPath);
          if (msg.email !== undefined) await spawnGit(vscode, ["config", "user.email", msg.email], projectPath);
          const [n, e] = await Promise.all([
            spawnGit(vscode, ["config", "user.name"], projectPath),
            spawnGit(vscode, ["config", "user.email"], projectPath),
          ]);
          await panel.webview.postMessage({ command: "loadUserDetails", data: { name: n.stdout.trim(), email: e.stdout.trim() } });
          break;
        }
        case "addRemote": {
          const remoteUrl = String(msg.url || "");
          if (!remoteUrl || remoteUrl.startsWith("-")) throw new Error("Invalid remote URL");
          await spawnGit(vscode, ["remote", "add", assertValidRemote(msg.name), remoteUrl], projectPath);
          await handleRepoInfo(vscode, panel, projectPath);
          break;
        }
        case "removeRemote":
          await spawnGit(vscode, ["remote", "remove", assertValidRemote(msg.name)], projectPath);
          await handleRepoInfo(vscode, panel, projectPath);
          break;
        case "editRemoteUrl": {
          const editUrl = String(msg.url || "");
          if (!editUrl || editUrl.startsWith("-")) throw new Error("Invalid remote URL");
          await spawnGit(vscode, ["remote", "set-url", assertValidRemote(msg.name), editUrl], projectPath);
          await handleRepoInfo(vscode, panel, projectPath);
          break;
        }
        case "requestOwnerRepo": {
          const result = await spawnGit(vscode, ["remote", "get-url", "origin"], projectPath);
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
            assertSafeFilePaths(msg.args.files as string[], projectPath);
          }
          if (msg.action === "discard") {
            await handleDiscard(vscode, panel, projectPath, context, msg.args);
          } else {
            await handleGitAction(vscode, panel, projectPath, context, msg.action, msg.args);
          }
          break;
        case "openFile": {
          assertSafeFilePaths([msg.filePath], projectPath);
          const projectName = await resolveProjectName(projectPath);
          await vscode.window.openTab("editor", msg.filePath, projectName, {
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
  });

  context.subscriptions.push(msgDisposable);

  // Poll uncommitted changes every 5 seconds
  let disposed = false;
  const uncommittedPollTimer = setInterval(() => {
    if (!disposed) handleUncommittedStatus(vscode, panel, projectPath);
  }, 5_000);

  panel.onDidDispose(() => {
    disposed = true;
    clearInterval(uncommittedPollTimer);
    msgDisposable.dispose();
  });
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
    spawnGit(vscode, ["stash", "list", "--format=%gd|%H|%s"], projectPath),
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
    args.push("--all");
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

async function handleUncommittedStatus(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
): Promise<void> {
  try {
    const result = await spawnGit(vscode, ["status", "--porcelain=v1"], projectPath, 10_000);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      await panel.webview.postMessage({ command: "loadUncommitted", data: null });
      return;
    }
    const staged: import("./types.ts").FileChange[] = [];
    const unstaged: import("./types.ts").FileChange[] = [];
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      if (staged.length + unstaged.length >= 500) break; // cap total
      const x = line[0]; // staged status
      const y = line[1]; // unstaged status
      const filePath = line.substring(3);
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
    await panel.webview.postMessage({
      command: "loadUncommitted",
      data: { staged, unstaged },
    });
  } catch {
    await panel.webview.postMessage({ command: "loadUncommitted", data: null });
  }
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
    const [, hash, ...messageParts] = parts;
    return { index: i, hash, message: messageParts.join("|") };
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

// --- Input validation for git actions ---

function assertValidHash(value: unknown): string {
  const s = String(value || "");
  if (s === "HEAD") return s;
  if (!/^[0-9a-f]{4,40}$/i.test(s)) throw new Error(`Invalid commit hash: "${s}"`);
  return s;
}

function assertValidRef(value: unknown, label: string): string {
  const s = String(value || "");
  if (!s || /[\x00-\x1f\x7f~^:?*[\]\\]/.test(s) || s.startsWith("-") || s.includes("..")) {
    throw new Error(`Invalid git ref for ${label}: "${s}"`);
  }
  return s;
}

function assertValidRemote(value: unknown): string {
  const s = String(value || "");
  if (!s || /[\x00-\x1f\x7f]/.test(s) || s.startsWith("-")) {
    throw new Error(`Invalid remote name: "${s}"`);
  }
  return s;
}

/** Validate file paths are relative and don't escape the project root */
function assertSafeFilePaths(files: string[], projectPath: string): void {
  const { resolve, normalize } = require("path");
  const root = normalize(projectPath) + "/";
  for (const f of files) {
    if (!f || f.startsWith("-") || f.startsWith("/") || /[\x00-\x1f\x7f]/.test(f)) {
      throw new Error(`Invalid file path: "${f}"`);
    }
    const resolved = normalize(resolve(projectPath, f));
    if (!resolved.startsWith(root) && resolved !== normalize(projectPath)) {
      throw new Error(`File path escapes project root: "${f}"`);
    }
  }
}

function buildGitActionArgs(action: string, args: Record<string, unknown>): string[] {
  const VALID_RESET_MODES = ["soft", "mixed", "hard"];

  switch (action) {
    case "checkout": return ["checkout", assertValidRef(args.target, "target")];
    case "createBranch": return ["branch", assertValidRef(args.name, "name"), ...(args.startPoint ? [assertValidHash(args.startPoint)] : [])];
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
