/**
 * `GET /git/commit-line`, against a repository built for the purpose.
 *
 * The service is unit-tested separately; what this covers is the seam between
 * them — the query parsing, and that a hash the browser passes straight back
 * from a blame it already has really does come back as a line diff. A route
 * that answers 200 with `null` for everything would pass every service test
 * and show an empty hover.
 *
 * It used to run against *this* repository and pin a commit of it by hash. The
 * squash that produced this branch rewrote that commit, so the hash resolved
 * nowhere and three tests here failed for everyone, on every machine, for as
 * long as the branch existed — and the next rebase would have done it again to
 * any replacement hash. A repository this file creates cannot be rewritten by
 * anything outside it.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { gitRoutes } from "../../../src/server/routes/git.ts";
import type { BlameLineDetail } from "../../../src/shared/blame.ts";

let repo: string;
let HASH: string;
const FILE = "src/editor.ts";

/** Keep the real environment — replacing it drops HOME and git ignores config. */
function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com",
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05+00:00", GIT_COMMITTER_DATE: "2026-01-02T03:04:05+00:00",
    },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** The route reads `projectPath` from context, which middleware normally sets. */
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("projectPath", repo);
  await next();
});
app.route("/git", gitRoutes);

async function get(query: string): Promise<{ status: number; body: { ok: boolean; data?: unknown; error?: string } }> {
  const res = await app.request(`/git/commit-line?${query}`);
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: unknown; error?: string } };
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ppm-commit-line-"));
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(["add", "."]);
  git(["commit", "-qm", "root commit"]);

  // Two files, so the second commit can leave one of them alone: the hover has to
  // answer for a line the commit never touched as well as for one it rewrote.
  const before = [
    'import { mount } from "./mount";',
    "",
    "export function editor() {",
    '  const fontFamily = "Menlo, Monaco, Consolas, monospace";',
    "  return mount(fontFamily);",
    "}",
    "",
  ].join("\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, FILE), before);
  writeFileSync(join(repo, "src/untouched.ts"), "export const untouched = true;\n");
  git(["add", "."]);
  git(["commit", "-qm", "the commit before"]);

  const after = [
    'import { EDITOR_FONT_FAMILY } from "./editor-font";',
    'import { mount } from "./mount";',
    "",
    "export function editor() {",
    "  const fontFamily = EDITOR_FONT_FAMILY;",
    "  return mount(fontFamily);",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(repo, FILE), after);
  git(["commit", "-qam", "use the shared font stack, with inlay hints that actually arrive"]);
  HASH = git(["rev-parse", "--short=8", "HEAD"]);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("GET /git/commit-line", () => {
  it("returns the commit and the line's own replacement", async () => {
    // Line 5 after the change: the assignment the commit rewrote.
    const { status, body } = await get(`hash=${HASH}&path=${encodeURIComponent(FILE)}&line=5`);
    const detail = body.data as BlameLineDetail;

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(detail.message).toContain("inlay hints that actually arrive");
    expect(detail.removed).toEqual(['  const fontFamily = "Menlo, Monaco, Consolas, monospace";']);
    expect(detail.added).toEqual(["  const fontFamily = EDITOR_FONT_FAMILY;"]);
  });

  it("returns an addition with nothing removed", async () => {
    const { body } = await get(`hash=${HASH}&path=${encodeURIComponent(FILE)}&line=1`);
    const detail = body.data as BlameLineDetail;

    expect(detail.removed).toEqual([]);
    expect(detail.added).toEqual(['import { EDITOR_FONT_FAMILY } from "./editor-font";']);
  });

  it("still returns the commit for a line it did not touch", async () => {
    // The hover is worth showing for its message alone; only the diff section
    // goes away.
    const { body } = await get(`hash=${HASH}&path=${encodeURIComponent("src/untouched.ts")}&line=1`);
    const detail = body.data as BlameLineDetail;

    expect(detail.message).toContain("inlay hints");
    expect(detail.added).toEqual([]);
  });

  it("answers null for a hash git cannot resolve", async () => {
    // An unknown revision is "no hover", not a 500.
    const { status, body } = await get(`hash=deadbeef&path=${encodeURIComponent(FILE)}&line=1`);

    expect(status).toBe(200);
    expect(body.data).toBeNull();
  });

  it("rejects a missing hash, path or line", async () => {
    expect((await get(`path=${FILE}&line=1`)).status).toBe(400);
    expect((await get(`hash=${HASH}&line=1`)).status).toBe(400);
    expect((await get(`hash=${HASH}&path=${FILE}`)).status).toBe(400);
  });

  it("rejects a line that is not a positive integer", async () => {
    for (const line of ["0", "-3", "abc", "1.5"]) {
      expect((await get(`hash=${HASH}&path=${FILE}&line=${line}`)).status).toBe(400);
    }
  });

  it("refuses a hash that is not a hash, rather than handing it to git", async () => {
    const { status, body } = await get(`hash=${encodeURIComponent("--upload-pack=evil")}&path=${FILE}&line=1`);

    expect(status).toBe(500);
    expect(body.error).toContain("Invalid commit hash");
  });

  it("refuses a path that escapes the repository", async () => {
    const { status } = await get(`hash=${HASH}&path=${encodeURIComponent("../../etc/passwd")}&line=1`);

    expect(status).toBe(500);
  });
});
