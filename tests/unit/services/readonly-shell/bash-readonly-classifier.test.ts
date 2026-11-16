/**
 * The read-only bash check over the adversarial corpus, plus the cases that need a filesystem
 * shape of their own: repositories whose `.git` file points elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../../test-setup.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyBashCommand } from "../../../../src/services/assistant/readonly-shell/bash-readonly-classifier.ts";
import { judgeNativeArgv } from "../../../../src/services/assistant/readonly-shell/readonly-command-specs.ts";
import { adversarialBashCorpus, createCorpusFixture, q, type CorpusFixture } from "./adversarial-bash-corpus.ts";

let fx: CorpusFixture;

beforeAll(() => {
  fx = createCorpusFixture();
});

afterAll(() => {
  fx.cleanup();
});

describe("adversarial corpus", () => {
  it("holds at least 80 cases, every one with the expected verdict", () => {
    const cases = adversarialBashCorpus(fx);
    expect(cases.length).toBeGreaterThanOrEqual(80);
    const wrong = cases
      .map((c) => ({ c, v: classifyBashCommand(c.command, { ...fx.ctx, ...c.ctx }) }))
      .filter(({ c, v }) => v.verdict !== c.expected)
      .map(({ c, v }) => `${JSON.stringify(c.command)} (${c.why}): expected ${c.expected}, got ${v.verdict} — ${v.reason}`);
    expect(wrong).toEqual([]);
  });

  it("gives every verdict a reason", () => {
    for (const c of adversarialBashCorpus(fx)) {
      expect(classifyBashCommand(c.command, { ...fx.ctx, ...c.ctx }).reason.length).toBeGreaterThan(0);
    }
  });

  it("asks once anything outside the grammar follows an accepted command", () => {
    const accepted = adversarialBashCorpus(fx).filter((c) => c.expected === "readonly" && !c.ctx);
    for (const c of accepted) {
      for (const tail of [" $X", " `id`", " > f", " &", "\nrm x", " #", " *", " \\"]) {
        expect(classifyBashCommand(c.command + tail, fx.ctx).verdict).toBe("ask");
      }
    }
  });
});

describe("input that is not a command", () => {
  it("asks for non-strings, blank text and very long text", () => {
    for (const input of [undefined, null, 42, {}, "", "   "]) expect(classifyBashCommand(input, fx.ctx).verdict).toBe("ask");
    expect(classifyBashCommand(`echo ${"a".repeat(5000)}`, fx.ctx).verdict).toBe("ask");
  });
});

describe("a .git file pointing elsewhere", () => {
  it("follows a worktree's gitdir and its commondir, and asks when either leaves the read roots", () => {
    const main = join(fx.proj, "main-repo");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
    const worktree = join(fx.proj, "wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect(classifyBashCommand(`git -C ${q(worktree)} status`, fx.ctx).verdict).toBe("readonly");

    const escaping = join(fx.proj, "escaping");
    mkdirSync(join(escaping, "gitdir"), { recursive: true });
    writeFileSync(join(escaping, "gitdir", "commondir"), `${join(fx.home, ".ssh")}\n`);
    const wt2 = join(fx.proj, "wt2");
    mkdirSync(wt2, { recursive: true });
    writeFileSync(join(wt2, ".git"), `gitdir: ${join(escaping, "gitdir")}\n`);
    expect(classifyBashCommand(`git -C ${q(wt2)} log -p`, fx.ctx).verdict).toBe("ask");
  });

  it("asks when the gitdir points out of every read root", () => {
    const repo = join(fx.proj, "pointer");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".git"), `gitdir: ${join(fx.home, ".dotfiles-git")}\n`);
    expect(classifyBashCommand(`git -C ${q(repo)} log -p`, fx.ctx).verdict).toBe("ask");
    writeFileSync(join(repo, ".git"), "not a pointer\n");
    expect(classifyBashCommand(`git -C ${q(repo)} status`, fx.ctx).verdict).toBe("ask");
  });

  it("finds the repository from a subfolder without leaving the project", () => {
    expect(classifyBashCommand(`git -C ${q(join(fx.proj, "src"))} log --oneline`, fx.ctx).verdict).toBe("readonly");
  });
});

describe("argv judged without bash", () => {
  it("answers the same for an argv as for the command text", () => {
    expect(judgeNativeArgv(["git", "-C", fx.proj, "status"], fx.ctx).verdict).toBe("readonly");
    expect(judgeNativeArgv(["git", "-c", "core.pager=sh", "log"], fx.ctx).verdict).toBe("ask");
    expect(judgeNativeArgv(["cat", join(fx.proj, "a.json")], fx.ctx).verdict).toBe("readonly");
    expect(judgeNativeArgv(["cat", join(fx.home, ".ssh", "id_rsa")], fx.ctx).verdict).toBe("ask");
    expect(judgeNativeArgv(["rm", join(fx.proj, "f")], fx.ctx).verdict).toBe("ask");
    expect(judgeNativeArgv([], fx.ctx).verdict).toBe("ask");
  });

  it("does not take a flag after a path on macOS, where BSD tools read it as a file", () => {
    const darwin = { ...fx.ctx, platform: "darwin" };
    expect(judgeNativeArgv(["ls", fx.proj, "-la"], darwin).verdict).toBe("ask");
    expect(judgeNativeArgv(["ls", "-la", fx.proj], darwin).verdict).toBe("readonly");
    expect(judgeNativeArgv(["ls", fx.proj, "-la"], { ...fx.ctx, platform: "linux" }).verdict).toBe("readonly");
  });

  it("never lets an optional flag value swallow the next path", () => {
    expect(judgeNativeArgv(["ls", "--color", join(fx.home, ".ssh")], fx.ctx).verdict).toBe("ask");
    expect(judgeNativeArgv(["ls", "--color=never", fx.proj], fx.ctx).verdict).toBe("readonly");
  });
});
