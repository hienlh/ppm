import { simpleGit } from "simple-git";
import type { SimpleGit } from "simple-git";
import { resolve } from "path";
import type { GitBranch, GitCommit, GitFileChange, GitGraphData, GitStatus } from "../types/git.ts";

export class GitService {
  private git(projectPath: string): SimpleGit {
    return simpleGit(resolve(projectPath));
  }

  async status(projectPath: string): Promise<GitStatus> {
    const g = this.git(projectPath);
    const s = await g.status();
    const files: GitFileChange[] = [];

    const mapStatus = (x: string): GitFileChange["status"] => {
      if (x === "A" || x === "?" || x === "!") return "added";
      if (x === "D") return "deleted";
      if (x === "R") return "renamed";
      if (x === "C") return "copied";
      return "modified";
    };

    for (const f of s.files) {
      const staged = f.index !== " " && f.index !== "?";
      const unstaged = f.working_dir !== " " && f.working_dir !== "?";
      if (staged) {
        files.push({ path: f.path, status: mapStatus(f.index), staged: true, oldPath: f.from });
      }
      if (unstaged) {
        files.push({ path: f.path, status: mapStatus(f.working_dir), staged: false, oldPath: f.from });
      }
      if (!staged && !unstaged && (f.index === "?" || f.working_dir === "?")) {
        files.push({ path: f.path, status: "added", staged: false });
      }
    }

    return {
      branch: s.current ?? "HEAD",
      ahead: s.ahead,
      behind: s.behind,
      files,
    };
  }

  async diff(projectPath: string, ref1?: string, ref2?: string): Promise<string> {
    const g = this.git(projectPath);
    if (ref1 && ref2) return g.diff([ref1, ref2]);
    if (ref1) return g.diff([ref1]);
    return g.diff();
  }

  async fileDiff(projectPath: string, filePath: string, ref?: string): Promise<string> {
    const g = this.git(projectPath);
    if (ref) return g.diff([ref, "--", filePath]);
    return g.diff(["--", filePath]);
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

  async push(projectPath: string, remote?: string, branch?: string): Promise<void> {
    const args: string[] = [];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.git(projectPath).push(args);
  }

  async pull(projectPath: string, remote?: string, branch?: string): Promise<void> {
    const args: string[] = [];
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    await this.git(projectPath).pull(...(args as [string?, string?]));
  }

  async branches(projectPath: string): Promise<GitBranch[]> {
    const g = this.git(projectPath);
    const summary = await g.branch(["-vv", "--all"]);
    return Object.values(summary.branches).map((b) => {
      const isRemote = b.name.startsWith("remotes/");
      const ahead = 0;
      const behind = 0;
      return {
        name: isRemote ? b.name.replace(/^remotes\//, "") : b.name,
        current: b.current,
        remote: isRemote,
        commitHash: b.commit,
        ahead,
        behind,
      };
    });
  }

  async createBranch(projectPath: string, name: string, from?: string): Promise<void> {
    const args = from ? [name, from] : [name];
    await this.git(projectPath).checkoutLocalBranch(name);
    if (from) {
      await this.git(projectPath).branch(args);
    }
  }

  async checkout(projectPath: string, ref: string): Promise<void> {
    await this.git(projectPath).checkout(ref);
  }

  async deleteBranch(projectPath: string, name: string, force = false): Promise<void> {
    const flag = force ? "-D" : "-d";
    await this.git(projectPath).branch([flag, name]);
  }

  async merge(projectPath: string, source: string): Promise<void> {
    await this.git(projectPath).merge([source]);
  }

  async graphData(projectPath: string, maxCount = 200): Promise<GitGraphData> {
    const g = this.git(projectPath);
    const log = await g.log([
      "--all",
      `--max-count=${maxCount}`,
      "--format=%H%n%P%n%an%n%ae%n%at%n%s%n%D",
      "--decorate=full",
    ]);

    const rawLines = (await g.raw([
      "log",
      "--all",
      `--max-count=${maxCount}`,
      "--format=%H%n%P%n%an%n%ae%n%at%n%s%n%D",
    ])).split("\n");

    const commits: GitCommit[] = [];
    let i = 0;
    while (i < rawLines.length) {
      const hash = rawLines[i]?.trim();
      if (!hash || hash.length < 10) { i++; continue; }
      const parentsLine = rawLines[i + 1]?.trim() ?? "";
      const parents = parentsLine ? parentsLine.split(" ").filter(Boolean) : [];
      const authorName = rawLines[i + 2]?.trim() ?? "";
      const authorEmail = rawLines[i + 3]?.trim() ?? "";
      const authorTimestamp = rawLines[i + 4]?.trim() ?? "";
      const subject = rawLines[i + 5]?.trim() ?? "";
      const refsLine = rawLines[i + 6]?.trim() ?? "";
      const refs = refsLine ? refsLine.split(",").map((r) => r.trim()).filter(Boolean) : [];

      commits.push({
        hash,
        abbreviatedHash: hash.slice(0, 7),
        subject,
        body: "",
        authorName,
        authorEmail,
        authorDate: authorTimestamp && !isNaN(parseInt(authorTimestamp))
          ? new Date(parseInt(authorTimestamp) * 1000).toISOString()
          : "",
        parents,
        refs,
      });
      i += 8; // 7 lines + 1 blank separator
    }

    const branchList = await this.branches(projectPath);
    return { commits, branches: branchList };
  }

  async cherryPick(projectPath: string, hash: string): Promise<void> {
    await this.git(projectPath).raw(["cherry-pick", hash]);
  }

  async revert(projectPath: string, hash: string): Promise<void> {
    await this.git(projectPath).raw(["revert", hash, "--no-edit"]);
  }

  async createTag(projectPath: string, name: string, hash?: string): Promise<void> {
    const args = hash ? ["tag", name, hash] : ["tag", name];
    await this.git(projectPath).raw(args);
  }

  async getCreatePrUrl(projectPath: string, branch: string): Promise<string | null> {
    try {
      const g = this.git(projectPath);
      const remotes = await g.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin") ?? remotes[0];
      if (!origin?.refs?.fetch) return null;

      const url = origin.refs.fetch;
      // Parse GitHub: git@github.com:owner/repo.git or https://github.com/owner/repo.git
      const githubMatch = url.match(/github\.com[:/]([^/]+)\/([^.]+?)(?:\.git)?$/);
      if (githubMatch) {
        const [, owner, repo] = githubMatch;
        return `https://github.com/${owner}/${repo}/compare/${encodeURIComponent(branch)}?expand=1`;
      }

      // GitLab
      const gitlabMatch = url.match(/gitlab\.com[:/]([^/]+)\/([^.]+?)(?:\.git)?$/);
      if (gitlabMatch) {
        const [, owner, repo] = gitlabMatch;
        return `https://gitlab.com/${owner}/${repo}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}`;
      }

      return null;
    } catch {
      return null;
    }
  }
}

export const gitService = new GitService();
