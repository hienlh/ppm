import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCompareView } from "./compare-view.ts";
import { _resetPanelRegistry } from "./panel-registry.ts";
import type { ExtensionContext } from "@ppm/vscode-compat";

/**
 * The compare panel lists files for a whole range but opens one file at a time,
 * and those two have to agree on the base.
 *
 * In three-dot mode the list comes from `git diff ref1...ref2`, i.e. against the
 * merge base. Handing the tab `ref1` itself is a two-dot diff, so every commit
 * ref1 gained since the branch point renders as a deletion inside a review of
 * ref2 — with numbers that contradict the row that was clicked.
 */

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test Committer",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

let repo: string;

async function git(args: string[], cwd = repo) {
  const proc = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

interface OpenedTab {
  tabType: string;
  title: string;
  metadata: Record<string, unknown>;
}

function createFakeVscode() {
  const opened: OpenedTab[] = [];
  let listener: ((msg: unknown) => void) | null = null;

  const vscode = {
    commands: { registerCommand: () => ({ dispose() {} }) },
    window: {
      async showErrorMessage() { return undefined; },
      async showInformationMessage() { return undefined; },
      async openTab(tabType: string, title: string, _projectId: string | null, metadata?: Record<string, unknown>) {
        opened.push({ tabType, title, metadata: metadata ?? {} });
      },
      async switchProject() {},
      createWebviewPanel() {
        return {
          webview: {
            html: "",
            onDidReceiveMessage(l: (msg: unknown) => void) {
              listener = l;
              return { dispose() {} };
            },
            postMessage: async () => true,
          },
          onDidDispose: () => ({ dispose() {} }),
          dispose() {},
        };
      },
    },
    process: {
      async spawn(cmd: string, args: string[], cwd: string) {
        const proc = Bun.spawn([cmd, ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      },
    },
    ViewColumn: { Active: 1 },
  };

  return { vscode, opened, send: (msg: unknown) => listener?.(msg) };
}

/** `onMessage` is dispatched with `void`, so the result has to be polled for. */
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("compare panel diff base", () => {
  beforeEach(async () => {
    _resetPanelRegistry();
    repo = mkdtempSync(join(tmpdir(), "ppm-compare-base-"));
    await git(["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    await git(["add", "."]);
    await git(["commit", "-m", "initial"]);

    // The feature branch: one file, added after the branch point.
    await git(["checkout", "-b", "feature"]);
    writeFileSync(join(repo, "feature.txt"), "feature work\n");
    await git(["add", "."]);
    await git(["commit", "-m", "add feature"]);

    // main moves on afterwards — this is what makes the two modes differ.
    await git(["checkout", "main"]);
    writeFileSync(join(repo, "README.md"), "base\nchanged on main\n");
    writeFileSync(join(repo, "other.txt"), "unrelated\n");
    await git(["add", "."]);
    await git(["commit", "-m", "move main ahead"]);
    await git(["checkout", "feature"]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("opens a three-dot row against the merge base, not ref1's tip", async () => {
    const { vscode, opened, send } = createFakeVscode();
    openCompareView(vscode as any, {} as ExtensionContext, repo);

    send({ command: "openDiff", filePath: "feature.txt", ref1: "main", ref2: "feature", mode: "three-dot" });
    const tab = await waitFor(() => opened[0], "the diff tab");

    const base = (await git(["merge-base", "main", "feature"])).stdout.trim();
    const mainTip = (await git(["rev-parse", "main"])).stdout.trim();

    expect(base).not.toBe(mainTip); // the setup is only meaningful while these differ
    expect(tab.tabType).toBe("git-diff");
    expect(tab.metadata.ref1).toBe(base);
    expect(tab.metadata.ref2).toBe("feature");
    expect(tab.title).toContain("main...feature");
  });

  it("leaves ref1 alone in two-dot mode", async () => {
    const { vscode, opened, send } = createFakeVscode();
    openCompareView(vscode as any, {} as ExtensionContext, repo);

    send({ command: "openDiff", filePath: "feature.txt", ref1: "main", ref2: "feature", mode: "two-dot" });
    const tab = await waitFor(() => opened[0], "the diff tab");

    expect(tab.metadata.ref1).toBe("main");
    expect(tab.title).toContain("main..feature");
  });

  it("the base it opens reproduces the counts the file list showed", async () => {
    const { vscode, opened, send } = createFakeVscode();
    openCompareView(vscode as any, {} as ExtensionContext, repo);

    send({ command: "openDiff", filePath: "README.md", ref1: "main", ref2: "feature", mode: "three-dot" });
    const tab = await waitFor(() => opened[0], "the diff tab");

    // What the panel listed: README.md is untouched by the feature branch, so
    // three-dot reports nothing for it at all.
    const listed = (await git(["diff", "--numstat", "main...feature"])).stdout;
    expect(listed).not.toContain("README.md");

    // What the tab now shows for the same file: equally nothing.
    const shown = (await git(["diff", "--numstat", `${tab.metadata.ref1}`, "feature", "--", "README.md"])).stdout;
    expect(shown.trim()).toBe("");

    // And what it showed before the fix: main's own commit, backwards.
    const twoDot = (await git(["diff", "--numstat", "main", "feature", "--", "README.md"])).stdout;
    expect(twoDot).toContain("README.md");
  });
});
