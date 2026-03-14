import simpleGit, { type SimpleGit } from "simple-git";
import type {
  GitStatus,
  GitFileChange,
  GitCommit,
  GitBranch,
  GitGraphData,
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

  async fileDiff(
    projectPath: string,
    filePath: string,
    ref?: string,
  ): Promise<string> {
    const git = this.git(projectPath);
    const args: string[] = [];
    if (ref) args.push(ref);
    args.push("--", filePath);
    return git.diff(args);
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
  ): Promise<GitGraphData> {
    const git = this.git(projectPath);

    // Use simple-git built-in log
    const log = await git.log({ "--all": null, maxCount });

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
      const parentLog = await git.raw([
        "log",
        "--all",
        `--max-count=${maxCount}`,
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

    // simple-git branch().commit returns abbreviated hash — map to full hash
    const abbrToFull = new Map<string, string>();
    for (const c of commits) {
      abbrToFull.set(c.abbreviatedHash, c.hash);
      // Also index with longer prefixes for safety
      abbrToFull.set(c.hash.slice(0, 8), c.hash);
      abbrToFull.set(c.hash.slice(0, 10), c.hash);
    }

    const branches: GitBranch[] = Object.entries(branchSummary.branches).map(
      ([name, info]) => ({
        name,
        current: info.current,
        remote: name.startsWith("remotes/"),
        commitHash: abbrToFull.get(info.commit) ?? info.commit,
        ahead: 0,
        behind: 0,
      }),
    );

    return { commits, branches };
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
