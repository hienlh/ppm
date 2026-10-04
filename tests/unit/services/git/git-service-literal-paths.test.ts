/**
 * Whole-file stage, unstage and discard take each name as that one file.
 *
 * git reads a path argument as a pattern, so `[ab].txt` also matched `a.txt`:
 * discarding the first threw away the second's changes too, with nothing to
 * restore them from.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitService } from "../../../../src/services/git.service.ts";

let repo: string;

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: repo, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.x" },
  });
  const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (await proc.exited !== 0) throw new Error(`git ${args.join(" ")}: ${errText}`);
  return out;
}
const write = (p: string, text: string) => writeFileSync(join(repo, p), text);

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "ppm-literal-"));
  await git(["init", "-q", "-b", "main"]);
  // These tests compare bytes, and Git for Windows checks text out with CRLF by default.
  await git(["config", "core.autocrlf", "false"]);
  write("a.txt", "a\n");
  write("[ab].txt", "glob\n");
  await git(["add", "-A"]);
  await git(["commit", "-qm", "initial"]);
  write("a.txt", "a changed\n");
  write("[ab].txt", "glob changed\n");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("glob-looking file names", () => {
  it("stages and unstages only the named file", async () => {
    await gitService.stage(repo, ["[ab].txt"]);
    expect(await git(["status", "--porcelain=v1"])).toBe("M  [ab].txt\n M a.txt\n");
    await gitService.unstage(repo, ["[ab].txt"]);
    expect(await git(["status", "--porcelain=v1"])).toBe(" M [ab].txt\n M a.txt\n");
  });

  it("discards only the named file", async () => {
    await gitService.discardChanges(repo, ["[ab].txt"]);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a changed\n");
    expect(readFileSync(join(repo, "[ab].txt"), "utf8")).toBe("glob\n");
  });

  it("cleans only the named untracked file", async () => {
    write("n[x].md", "n\n");
    write("nx.md", "x\n");
    await gitService.discardChanges(repo, ["n[x].md"]);
    expect(await git(["status", "--porcelain=v1", "--", "nx.md"])).toBe("?? nx.md\n");
  });
});

describe("names that look like options", () => {
  it("stages a file called --all as that file, not as `git add --all`", async () => {
    // Without `--`, git read the name as its flag and staged every file in the tree.
    write("--all", "x\n");
    write("secret.env", "TOKEN=1\n");
    await gitService.stage(repo, ["--all"]);
    expect(await git(["status", "--porcelain=v1", "--", "--all", "secret.env"])).toBe("A  --all\n?? secret.env\n");
  });
});
