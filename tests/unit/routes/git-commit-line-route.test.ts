/**
 * `GET /git/commit-line`, against this repository's own history.
 *
 * The service is unit-tested separately; what this covers is the seam between
 * them — the query parsing, and that a hash the browser passes straight back
 * from a blame it already has really does come back as a line diff. A route
 * that answers 200 with `null` for everything would pass every service test
 * and show an empty hover.
 */
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { gitRoutes } from "../../../src/server/routes/git.ts";
import type { BlameLineDetail } from "../../../src/shared/blame.ts";

/** The route reads `projectPath` from context, which middleware normally sets. */
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("projectPath", process.cwd());
  await next();
});
app.route("/git", gitRoutes);

async function get(query: string): Promise<{ status: number; body: { ok: boolean; data?: unknown; error?: string } }> {
  const res = await app.request(`/git/commit-line?${query}`);
  return { status: res.status, body: (await res.json()) as { ok: boolean; data?: unknown; error?: string } };
}

// `805bfdd6` rewrote code-editor.tsx's fontFamily and added the import above it.
const HASH = "805bfdd6";
const FILE = "src/web/components/editor/code-editor.tsx";

describe("GET /git/commit-line", () => {
  it("returns the commit and the line's own replacement", async () => {
    const { status, body } = await get(`hash=${HASH}&path=${encodeURIComponent(FILE)}&line=857`);
    const detail = body.data as BlameLineDetail;

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(detail.message).toContain("inlay hints that actually arrive");
    expect(detail.removed).toEqual(['              fontFamily: "Menlo, Monaco, Consolas, monospace",']);
    expect(detail.added).toEqual(["              fontFamily: EDITOR_FONT_FAMILY,"]);
  });

  it("returns an addition with nothing removed", async () => {
    const { body } = await get(`hash=${HASH}&path=${encodeURIComponent(FILE)}&line=15`);
    const detail = body.data as BlameLineDetail;

    expect(detail.removed).toEqual([]);
    expect(detail.added).toEqual(['import { EDITOR_FONT_FAMILY } from "@/lib/editor-font";']);
  });

  it("still returns the commit for a line it did not touch", async () => {
    // The hover is worth showing for its message alone; only the diff section
    // goes away.
    const { body } = await get(`hash=${HASH}&path=${encodeURIComponent(FILE)}&line=400`);
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
