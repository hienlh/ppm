import path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import type {
  GitStatus,
  GitFileChange,
  GitCommit,
  GitBranch,
  GitGraphData,
  GitWorktree,
} from "../types/git.ts";

class GitService {
  private git(projectPath: string): SimpleGit {
    return simpleGit(projectPath);
  }

  async status(projectPath: string): Promise<GitStatus> {
    const git = this.git(projectPath);
    const s = await git.status();

    const staged: GitFileChange[] = [];
    for (const f of s.staged) {
      staged.push({ path: f, status: "M" });
    }
    for (const f of s.created) {
      if (s.staged.includes(f)) {
        // Override status for staged created files
        const idx = staged.findIndex((x) => x.path === f);
        if (idx >= 0) staged[idx]!.status = "A";
        else staged.push({ path: f, status: "A" });
      }
    }
    for (const f of s.deleted) {
      if (s.staged.includes(f)) {
        const idx = staged.findIndex((x) => x.path === f);
        if (idx >= 0) staged[idx]!.status = "D";
        else staged.push({ path: f, status: "D" });
      }
    }
    for (const f of s.renamed) {
      staged.push({ path: f.to, status: "R", oldPath: f.from });
    }

    // Build staged set from the raw diff result for accuracy
    const stagedSet = new Set<string>();
    const stagedFiles: GitFileChange[] = [];
    try {
      const diffStaged = await git.diff(["--cached", "--name-status"]);
      for (const line of diffStaged.trim().split("\n")) {
        if (!line) continue;
        const parts = line.split("\t");
        const statusChar = (parts[0] ?? "M").charAt(0) as GitFileChange["status"];
        const filePath = parts[1] ?? "";
        const oldPath = statusChar === "R" ? filePath : undefined;
        const actualPath = statusChar === "R" ? (parts[2] ?? filePath) : filePath;
        stagedSet.add(actualPath);
        stagedFiles.push({ path: actualPath, status: statusChar, oldPath });
      }
    } catch {
      // Fallback: empty repo or no HEAD
    }

    // Unstaged changes
    const unstaged: GitFileChange[] = [];
    try {
      const diffUnstaged = await git.diff(["--name-status"]);
      for (const line of diffUnstaged.trim().split("\n")) {
        if (!line) continue;
        const parts = line.split("\t");
        const statusChar = (parts[0] ?? "M").charAt(0) as GitFileChange["status"];
        const filePath = parts[1] ?? "";
        const oldPath = statusChar === "R" ? filePath : undefined;
        const actualPath = statusChar === "R" ? (parts[2] ?? filePath) : filePath;
        unstaged.push({ path: actualPath, status: statusChar, oldPath });
      }
    } catch {
      // empty
    }

    // Untracked files (not in staged)
    const untracked = s.not_added.filter((f) => !stagedSet.has(f));

    return {
      current: s.current,
      staged: stagedFiles.length > 0 ? stagedFiles : staged,
      unstaged,
      untracked,
    };
  }

  async diff(
    projectPath: string,
    ref1?: string,
    ref2?: string,
  ): Promise<string> {
    const git = this.git(projectPath);
    const args: string[] = [];
    if (ref1) args.push(ref1);
    if (ref2) args.push(ref2);
    return git.diff(args);
  }

  async diffStat(
    projectPath: string,
    ref1?: string,
    ref2?: string,
  ): Promise<Array<{ path: string; additions: number; deletions: number }>> {
    const git = this.git(projectPath);
    const args: string[] = ["--numstat"];
    if (ref1) args.push(ref1);
    if (ref2) args.push(ref2);
    const raw = await git.diff(args);
    const files: Array<{ path: string; additions: number; deletions: number }> = [];
    for (const line of raw.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      const additions = parseInt(parts[0] ?? "0", 10) || 0;
      const deletions = parseInt(parts[1] ?? "0", 10) || 0;
      const path = parts[2] ?? "";
      if (path) files.push({ path, additions, deletions });
    }
    return files;
  }

  async fileDiff(
    projectPath: string,
    filePath: string,
    ref?: string,
  ): Promise<string> {
    const git = this.git(projectPath);
    const args: string[] = [];
    if (ref) args.push(ref);
    args.push("--", filePath);
    const diff = await git.diff(args);

    // If diff is empty, file might be untracked or newly staged.
    // Try staged diff, then --no-index for untracked files.
    if (!diff.trim()) {
      const stagedDiff = await git.diff(["--cached", "--", filePath]);
      if (stagedDiff.trim()) return stagedDiff;

      // Untracked file: generate diff against /dev/null
      try {
        const result = await git.raw([
          "diff", "--no-index", "/dev/null", filePath,
        ]);
        return result;
      } catch (e: any) {
        // git diff --no-index exits with code 1 when there are differences
        if (e.message?.includes("exit code 1") || e.exitCode === 1) {
          return typeof e.stdout === "string" ? e.stdout : "";
        }
        return "";
      }
    }
    return diff;
  }

  async stage(projectPath: string, files: string[]): Promise<void> {
    await this.git(projectPath).add(files);
  }

  async unstage(projectPath: string, files: string[]): Promise<void> {
    await this.git(projectPath).reset(["HEAD", "--", ...files]);
  }

  async commit(projectPath: string, message: string): Promise<string> {
    const result = await this.git(projectPath).commit(message);
    return result.commit;
  }

  async push(
    projectPath: string,
    remote?: string,
    branch?: string,
  ): Promise<void> {
    const args: string[] = [];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.git(projectPath).push(args);
  }

  async pull(
    projectPath: string,
    remote?: string,
    branch?: string,
  ): Promise<void> {
    const args: string[] = [];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.git(projectPath).pull(args);
  }

  async branches(projectPath: string): Promise<GitBranch[]> {
    const git = this.git(projectPath);
    const summary = await git.branch(["-a", "--no-color"]);
    return Object.entries(summary.branches).map(([name, info]) => ({
      name,
      current: info.current,
      remote: name.startsWith("remotes/"),
      commitHash: info.commit,
      ahead: 0,
      behind: 0,
      remotes: [],
    }));
  }

  async createBranch(
    projectPath: string,
    name: string,
    from?: string,
  ): Promise<void> {
    const args = [name];
    if (from) args.push(from);
    await this.git(projectPath).checkoutBranch(name, from ?? "HEAD");
  }

  async checkout(projectPath: string, ref: string): Promise<void> {
    await this.git(projectPath).checkout(ref);
  }

  async deleteBranch(
    projectPath: string,
    name: string,
    force = false,
  ): Promise<void> {
    const flag = force ? "-D" : "-d";
    await this.git(projectPath).branch([flag, name]);
  }

  async merge(projectPath: string, source: string): Promise<void> {
    await this.git(projectPath).merge([source]);
  }

  async graphData(
    projectPath: string,
    maxCount = 200,
    skip = 0,
  ): Promise<GitGraphData> {
    const git = this.git(projectPath);

    // Use simple-git built-in log with skip support
    const logOpts: Record<string, unknown> = { "--all": null, maxCount };
    if (skip > 0) (logOpts as Record<string, unknown>)["--skip"] = skip;
    const log = await git.log(logOpts);

    const commits: GitCommit[] = log.all.map((c) => ({
      hash: c.hash,
      abbreviatedHash: c.hash.slice(0, 7),
      subject: c.message,
      body: c.body,
      authorName: c.author_name,
      authorEmail: c.author_email,
      authorDate: c.date,
      parents: [],
      refs: c.refs ? c.refs.split(", ").filter(Boolean) : [],
    }));

    // Get parent hashes via raw format
    try {
      const skipArgs = skip > 0 ? [`--skip=${skip}`] : [];
      const parentLog = await git.raw([
        "log",
        "--all",
        `--max-count=${maxCount}`,
        ...skipArgs,
        "--format=%H %P",
      ]);
      const parentMap = new Map<string, string[]>();
      for (const line of parentLog.trim().split("\n")) {
        if (!line) continue;
        const [hash, ...parents] = line.split(" ");
        if (hash) parentMap.set(hash, parents.filter(Boolean));
      }
      for (const c of commits) {
        c.parents = parentMap.get(c.hash) ?? [];
      }
    } catch {
      // May fail on empty repo
    }

    const branchSummary = await git.branch(["-a", "--no-color"]);

    // simple-git branch().commit returns abbreviated hash of varying lengths — index all common lengths
    const abbrToFull = new Map<string, string>();
    for (const c of commits) {
      abbrToFull.set(c.hash, c.hash);
      for (const len of [7, 8, 9, 10, 11, 12]) {
        abbrToFull.set(c.hash.slice(0, len), c.hash);
      }
    }

    const branches: GitBranch[] = Object.entries(branchSummary.branches).map(
      ([name, info]) => ({
        name,
        current: info.current,
        remote: name.startsWith("remotes/"),
        commitHash: abbrToFull.get(info.commit) ?? info.commit,
        ahead: 0,
        behind: 0,
        remotes: [] as string[],
      }),
    );

    // Compute remote tracking: for each local branch, find remotes that have it
    const localBranches = branches.filter((b) => !b.remote);
    const remoteBranches = branches.filter((b) => b.remote);
    for (const local of localBranches) {
      for (const remote of remoteBranches) {
        // remotes/origin/main → remote="origin", branch="main"
        const stripped = remote.name.replace(/^remotes\//, "");
        const slashIdx = stripped.indexOf("/");
        if (slashIdx < 0) continue;
        const remoteName = stripped.slice(0, slashIdx);
        const remoteBranchName = stripped.slice(slashIdx + 1);
        if (remoteBranchName === local.name) {
          local.remotes.push(remoteName);
        }
      }
    }

    // Get HEAD commit hash
    let head = "";
    try {
      head = (await git.revparse(["HEAD"])).trim();
    } catch {
      // empty repo
    }

    return { commits, branches, head };
  }

  async fetch(projectPath: string, remote?: string): Promise<void> {
    const args = remote ? [remote] : ["--all"];
    await this.git(projectPath).fetch(args);
  }

  async discardChanges(projectPath: string, files: string[]): Promise<void> {
    const git = this.git(projectPath);
    // Separate tracked vs untracked files
    const s = await git.status();
    const untrackedSet = new Set(s.not_added);
    const tracked = files.filter((f) => !untrackedSet.has(f));
    const untracked = files.filter((f) => untrackedSet.has(f));

    if (tracked.length > 0) {
      await git.checkout(["--", ...tracked]);
    }
    if (untracked.length > 0) {
      await git.clean("f", ["-e", "!.*", "--", ...untracked]);
    }
  }

  async cherryPick(projectPath: string, hash: string): Promise<void> {
    await this.git(projectPath).raw(["cherry-pick", hash]);
  }

  async revert(projectPath: string, hash: string): Promise<void> {
    await this.git(projectPath).raw(["revert", "--no-edit", hash]);
  }

  async createTag(
    projectPath: string,
    name: string,
    hash?: string,
  ): Promise<void> {
    const args = ["tag", name];
    if (hash) args.push(hash);
    await this.git(projectPath).raw(args);
  }

  async getCreatePrUrl(
    projectPath: string,
    branch: string,
  ): Promise<string | null> {
    try {
      const git = this.git(projectPath);
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      if (!origin) return null;

      const url = origin.refs.push || origin.refs.fetch;
      if (!url) return null;

      // Parse GitHub/GitLab URL
      const parsed = this.parseRemoteUrl(url);
      if (!parsed) return null;

      const encodedBranch = encodeURIComponent(branch);
      if (parsed.host.includes("github")) {
        return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/compare/${encodedBranch}?expand=1`;
      }
      if (parsed.host.includes("gitlab")) {
        return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/-/merge_requests/new?merge_request[source_branch]=${encodedBranch}`;
      }

      return null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Worktree operations
  // ---------------------------------------------------------------------------

  /** Parse `git worktree list --porcelain` output into GitWorktree[]. */
  async listWorktrees(projectPath: string): Promise<GitWorktree[]> {
    const git = this.git(projectPath);
    const raw = await git.raw(["worktree", "list", "--porcelain"]);
    const worktrees: GitWorktree[] = [];
    // Blocks are separated by blank lines
    const blocks = raw.trim().split(/\n\n+/);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const wt: GitWorktree = {
        path: "",
        branch: "",
        head: "",
        isMain: i === 0,
        isBare: false,
        isDetached: false,
        locked: false,
        prunable: false,
      };
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          wt.path = line.slice("worktree ".length);
        } else if (line.startsWith("HEAD ")) {
          wt.head = line.slice("HEAD ".length);
        } else if (line.startsWith("branch ")) {
          // refs/heads/main → main
          const ref = line.slice("branch ".length);
          wt.branch = ref.replace(/^refs\/heads\//, "");
        } else if (line === "bare") {
          wt.isBare = true;
        } else if (line === "detached") {
          wt.isDetached = true;
        } else if (line.startsWith("locked")) {
          wt.locked = true;
          const reason = line.slice("locked".length).trim();
          if (reason) wt.lockReason = reason;
        } else if (line.startsWith("prunable")) {
          wt.prunable = true;
        }
      }
      if (wt.path) worktrees.push(wt);
    }
    return worktrees;
  }

  /**
   * Validate that targetPath is safe: must be under the parent directory of
   * projectPath and must not contain path traversal sequences.
   */
  private validateWorktreePath(projectPath: string, targetPath: string): void {
    const resolvedTarget = path.resolve(targetPath);
    const parentDir = path.dirname(path.resolve(projectPath));
    if (!resolvedTarget.startsWith(parentDir + path.sep) && resolvedTarget !== parentDir) {
      throw new Error(`Worktree path must be within: ${parentDir}`);
    }
    if (resolvedTarget.includes("..")) {
      throw new Error("Worktree path must not contain '..'");
    }
  }

  /** Create a new worktree. */
  async addWorktree(
    projectPath: string,
    targetPath: string,
    opts: { branch?: string; newBranch?: string } = {},
  ): Promise<void> {
    this.validateWorktreePath(projectPath, targetPath);
    const args = ["worktree", "add"];
    if (opts.newBranch) {
      args.push("-b", opts.newBranch);
    }
    args.push(targetPath);
    if (opts.branch) {
      args.push(opts.branch);
    }
    await this.git(projectPath).raw(args);
  }

  /** Remove a worktree. Pass force=true to remove even with uncommitted changes. */
  async removeWorktree(projectPath: string, targetPath: string, force = false): Promise<void> {
    const args = ["worktree", "remove"];
    if (force) args.push("-f");
    args.push(targetPath);
    await this.git(projectPath).raw(args);
  }

  /** Prune stale worktree metadata from .git/worktrees/. */
  async pruneWorktrees(projectPath: string): Promise<void> {
    await this.git(projectPath).raw(["worktree", "prune"]);
  }

  private parseRemoteUrl(
    url: string,
  ): { host: string; owner: string; repo: string } | null {
    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return {
        host: sshMatch[1]!,
        owner: sshMatch[2]!,
        repo: sshMatch[3]!,
      };
    }
    // HTTPS: https://github.com/owner/repo.git
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
      if (parts.length >= 2) {
        return {
          host: parsed.host,
          owner: parts[0]!,
          repo: parts[1]!,
        };
      }
    } catch {
      // not a URL
    }
    return null;
  }
}

export const gitService = new GitService();
