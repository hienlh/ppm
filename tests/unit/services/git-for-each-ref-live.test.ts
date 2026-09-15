/**
 * The format string against real git.
 *
 * The unit test beside this one pins the parser to a fixture, which proves the
 * indices agree with the format *as written* — it cannot catch the format being
 * wrong. An atom git does not know is not an error either: `for-each-ref`
 * prints unknown text verbatim, so a typo yields a row full of plausible
 * rubbish. Only a real repository answers whether `%(*objectname)` and friends
 * behave the way the parser assumes.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitService } from "../../../src/services/git.service.ts";

let dir: string;

function git(...args: string[]): string {
  const out = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
  return out.stdout.toString().trim();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-refs-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "Tester");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "feat: the commit subject");
  git("tag", "-a", "v1", "-m", "the tag message");
  git("tag", "light");
  git("branch", "feature/x");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("gitService.refs against a real repository", () => {
  test("every ref namespace comes back, named as a user checks it out", async () => {
    const refs = await gitService.refs(dir);
    expect(refs.map((r) => `${r.type}:${r.name}`).sort()).toEqual([
      "branch:feature/x",
      "branch:main",
      "tag:light",
      "tag:v1",
    ]);
  });

  test("HEAD marks exactly one branch", async () => {
    const refs = await gitService.refs(dir);
    expect(refs.filter((r) => r.current).map((r) => r.name)).toEqual(["main"]);
  });

  test("an annotated tag reports the commit, its author and its subject", async () => {
    const refs = await gitService.refs(dir);
    const head = git("rev-parse", "HEAD");
    const annotated = refs.find((r) => r.name === "v1")!;

    // The tag object's own hash is what a parser skipping `%(*objectname)` shows.
    expect(git("rev-parse", "v1")).not.toBe(head);
    expect(annotated.hash).toBe(head);
    expect(annotated.author).toBe("Tester");
    expect(annotated.subject).toBe("feat: the commit subject");
    expect(annotated.date).not.toBe("");
  });

  test("a lightweight tag reads identically", async () => {
    const refs = await gitService.refs(dir);
    const [annotated, light] = [refs.find((r) => r.name === "v1")!, refs.find((r) => r.name === "light")!];
    expect(light.hash).toBe(annotated.hash);
    expect(light.author).toBe(annotated.author);
    expect(light.subject).toBe(annotated.subject);
  });

  test("a branch with no upstream is neither ahead, behind, nor gone", async () => {
    const refs = await gitService.refs(dir);
    const main = refs.find((r) => r.name === "main")!;
    expect({ upstream: main.upstream, ahead: main.ahead, behind: main.behind, gone: main.gone })
      .toEqual({ upstream: null, ahead: 0, behind: 0, gone: false });
  });
});
