/**
 * @ppm/ext-git-graph — Git Graph extension for PPM.
 * Visualizes git commit history as an interactive graph in a webview.
 */
import type { ExtensionContext } from "@ppm/vscode-compat";
import type { SpawnResult } from "@ppm/vscode-compat/src/process.ts";
import type { WebviewToExt } from "./types.ts";
import { getWebviewHtml } from "./webview-html.ts";

interface VscodeApi {
  commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): void };
  };
  window: {
    showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
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

export function activate(context: ExtensionContext, vscode: VscodeApi): void {
  baseUrl = (globalThis as any).__PPM_BASE_URL__ || "";

  context.subscriptions.push(
    vscode.commands.registerCommand("git-graph.view", async (...args: unknown[]) => {
      const projectPath = args[0] as string | undefined;
      const resolvedPath = projectPath || await resolveProjectPath();
      if (!resolvedPath) {
        await vscode.window.showErrorMessage("Git Graph: No project path provided");
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
    const json = await res.json() as { ok: boolean; data?: { path: string }[] };
    if (json.ok && json.data && json.data.length > 0) return json.data[0].path;
  } catch {}
  return null;
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
        case "requestRepoInfo":
          await handleRepoInfo(vscode, panel, projectPath);
          break;
        case "requestCommits":
          await handleRequestCommits(vscode, panel, projectPath, msg.maxCommits, msg.skip, msg.branch);
          break;
        case "requestCommitDetails":
          await handleCommitDetails(vscode, panel, projectPath, msg.hash);
          break;
        case "gitAction":
          await handleGitAction(vscode, panel, projectPath, msg.action, msg.args);
          break;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await panel.webview.postMessage({ command: "error", message: errMsg });
    }
  });

  context.subscriptions.push(msgDisposable);
  panel.onDidDispose(() => msgDisposable.dispose());
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
  maxCommits = 300,
  skip = 0,
  branch?: string,
): Promise<void> {
  const { parseGitLog } = await import("./git-log-parser.ts");
  const args = [
    "log",
    `--format=%H%n%P%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%D%n%s%n<END_COMMIT>`,
    "--topo-order",
    `-n`, String(maxCommits),
  ];
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

async function handleGitAction(
  vscode: VscodeApi,
  panel: ReturnType<VscodeApi["window"]["createWebviewPanel"]>,
  projectPath: string,
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
    await handleRequestCommits(vscode, panel, projectPath);
  }
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
    case "push": {
      const pushArgs = ["push"];
      if (args.remote) pushArgs.push(assertValidRemote(args.remote));
      if (args.branch) pushArgs.push(assertValidRef(args.branch, "branch"));
      if (args.force) pushArgs.push("--force");
      return pushArgs;
    }
    case "createTag": {
      const tagArgs = ["tag", assertValidRef(args.name, "name")];
      if (args.hash) tagArgs.push(assertValidHash(args.hash));
      if (args.message) tagArgs.push("-m", String(args.message));
      return tagArgs;
    }
    case "deleteTag": return ["tag", "-d", assertValidRef(args.name, "name")];
    default: throw new Error(`Unknown git action: ${action}`);
  }
}
