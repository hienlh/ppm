/**
 * A binary file in a diff, against real git.
 *
 * The diff editor used to render a committed PNG as thousands of lines of
 * U+FFFD, because `git show` hands simple-git a UTF-8 *string* and a PNG does
 * not survive that. The fix is upstream of the UI — the bytes decide — so this
 * runs the real routes over a real repository rather than asserting on a mock.
 *
 * The text cases are the regression half: reading both sides as bytes must hand
 * back exactly what the string path did, trailing newline included.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRoutes } from "../../src/server/routes/git.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

let repo: string;

/** A tiny but real PNG: signature + an IHDR length/type, NULs and all. */
const PNG_V1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
const PNG_V2 = new Uint8Array([...PNG_V1, 0x00, 0x01, 0x02, 0x03]);

function app() {
  const a = new Hono<Env>();
  a.use("/*", async (c, next) => {
    c.set("projectPath", repo);
    c.set("projectName", "repo");
    await next();
  });
  a.route("/git", gitRoutes);
  return a;
}

const request = (path: string) => app().request(path);

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await request(path);
  return { status: res.status, body: await res.json() };
}

function git(args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ppm-bindiff-"));
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "logo.png"), PNG_V1);
  writeFileSync(join(repo, "notes.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "page.html"), "<script>alert(1)</script>\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "first"]);
  // Changed on both sides of the binary/text split, plus one file git has
  // never seen — the added-file case, where the left pane has nothing to draw.
  writeFileSync(join(repo, "logo.png"), PNG_V2);
  writeFileSync(join(repo, "notes.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "icon.ico"), PNG_V2);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("file-full-diff on a binary file", () => {
  it("reports binary and withholds both sides", async () => {
    const { body } = await getJson("/git/file-full-diff?file=logo.png");
    expect(body.ok).toBe(true);
    expect(body.data.binary).toBe(true);
    expect(body.data.original).toBe("");
    expect(body.data.modified).toBe("");
    // The sizes are what tell the viewer both versions exist.
    expect(body.data.originalSize).toBe(PNG_V1.length);
    expect(body.data.modifiedSize).toBe(PNG_V2.length);
  });

  it("hands the bytes over anyway when asked (Open Anyway)", async () => {
    const { body } = await getJson("/git/file-full-diff?file=logo.png&text=1");
    expect(body.data.binary).toBe(true);
    expect(body.data.original.length).toBeGreaterThan(0);
    expect(body.data.modified.length).toBeGreaterThan(0);
  });

  it("calls a file git has never seen an addition, not a change", async () => {
    const { body } = await getJson("/git/file-full-diff?file=icon.ico");
    expect(body.data.binary).toBe(true);
    expect(body.data.originalSize).toBe(null);
    expect(body.data.modifiedSize).toBe(PNG_V2.length);
  });
});

describe("file-full-diff on a text file", () => {
  it("still returns both sides verbatim", async () => {
    const { body } = await getJson("/git/file-full-diff?file=notes.txt");
    expect(body.data.binary).toBe(false);
    expect(body.data.original).toBe("one\ntwo\n");
    expect(body.data.modified).toBe("one\ntwo\nthree\n");
    expect(body.data.originalSize).toBe(8);
  });
});

describe("file-blob", () => {
  it("serves the committed bytes, not the working tree's", async () => {
    const res = await request("/git/file-blob?file=logo.png&ref=HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_V1);
  });

  it("answers 404 for a path the revision does not have", async () => {
    const { status } = await getJson("/git/file-blob?file=icon.ico&ref=HEAD");
    expect(status).toBe(404);
  });

  it("never names a content type the browser would execute", async () => {
    // A blob URL inherits the app's origin, so a repository that can name its
    // own MIME type can run script in it.
    const res = await request("/git/file-blob?file=page.html&ref=HEAD");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
