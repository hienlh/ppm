/**
 * What a commit does to the shared commit message (`POST /git/commit`).
 *
 * The commit's hooks can run for a while, and every box showing the message
 * stays open meanwhile: text typed into one is saved, and is the next
 * message. The commit used to clear the draft whatever it held by then.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRoutes } from "../../../src/server/routes/git.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { gitService } from "../../../src/services/git.service.ts";
import { gitCommitDraftService } from "../../../src/services/git-commit-draft.service.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

let repo: string;
let commit: ReturnType<typeof spyOn<typeof gitService, "commit">>;

async function post(message: string): Promise<number> {
  const app = new Hono<Env>();
  app.use("/*", async (c, next) => {
    c.set("projectPath", repo);
    c.set("projectName", "demo");
    await next();
  });
  app.route("/git", gitRoutes);
  const res = await app.request("/git/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return res.status;
}

/** A commit whose hooks are running while `meanwhile` happens. */
function committing(meanwhile: () => void) {
  commit.mockImplementation(async () => {
    meanwhile();
    return "a".repeat(40);
  });
}

beforeEach(() => {
  setDb(openTestDb());
  repo = mkdtempSync(join(tmpdir(), "ppm-commit-draft-"));
  commit = spyOn(gitService, "commit");
});

afterEach(() => {
  commit.mockRestore();
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("POST /git/commit and the shared message", () => {
  it("keeps a message saved while the commit ran", async () => {
    gitCommitDraftService.set(repo, "Fix lanes");
    committing(() => gitCommitDraftService.set(repo, "Fix lanes\n\nand the next thing"));
    expect(await post("Fix lanes")).toBe(200);
    expect(gitCommitDraftService.get(repo).message).toBe("Fix lanes\n\nand the next thing");
  });

  it("clears the message it committed, even when that save landed while the commit ran", async () => {
    gitCommitDraftService.set(repo, "Fix la");
    committing(() => gitCommitDraftService.set(repo, "Fix lanes\n"));
    expect(await post("Fix lanes")).toBe(200);
    expect(gitCommitDraftService.get(repo).message).toBe("");
  });

  it("clears an older message nobody saved to while the commit ran", async () => {
    // The box committed before its last keystrokes were saved.
    gitCommitDraftService.set(repo, "Fix la");
    committing(() => {});
    expect(await post("Fix lanes")).toBe(200);
    expect(gitCommitDraftService.get(repo).message).toBe("");
  });
});
