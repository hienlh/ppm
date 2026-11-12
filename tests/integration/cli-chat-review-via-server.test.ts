/**
 * `ppm chat changes`, `ppm chat turns` and `ppm chat revert-turn` against a scratch server with the
 * real chat and review routes: a session seeded with two turns of file changes
 * (`cli-chat-review-seed.ts`). A turn revert previewed and confirmed writes exactly the preview's
 * files, a file touched between preview and approval makes it write nothing, and Undo puts the files
 * back byte for byte.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";
import { SEED_B, SEED_BASE } from "../helpers/cli-chat-review-seed.ts";

let home: string;
let work: string;
let server: ScratchServer;
let n = 0;

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const read = (p: string) => readFileSync(p, "utf8");
const ok = async (args: string[]) => {
  const r = await runCli(home, args);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ code: 0 });
  return { ...r, stdout: plain(r.stdout) };
};

/** A new chat in project "rev" with two seeded turns of changes in a folder of its own. */
async function seededChat(): Promise<{ id: string; a: string; b: string; sub: string }> {
  const r = await ok(["chat", "create", "-p", "rev", "-t", `Review ${++n}`]);
  const id = /Created session: (\S+)/.exec(r.stdout)![1]!;
  const sub = `case${n}`;
  const files = await server.scratch<{ a: string; b: string }>("review/seed", { sessionId: id, dir: join(work, sub) });
  return { id, ...files, sub };
}

/** POST one of the chat's review routes on the server, as the browser does. */
async function post<T>(id: string, rest: string, body: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/project/rev/chat/sessions/${id}/file-changes${rest}`, {
    method: "POST", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return ((await res.json()) as { data: T }).data;
}

beforeAll(async () => {
  home = scratchHome();
  // Outside PPM_HOME: PPM never keeps copies of files inside its own folder.
  work = mkdtempSync(join(tmpdir(), "ppm-cli-review-work-"));
  server = await startScratchServer(home, null, undefined, "cli-chat-scratch-server-main.ts");
  mkdirSync(work, { recursive: true });
  await ok(["projects", "add", work, "-n", "rev"]);
}, 90_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("ppm chat review through the server", () => {
  it("lists the files and turns, shows a diff, keeps a file and undoes the keep", async () => {
    const { id, a, b, sub } = await seededChat();
    const list = JSON.parse((await ok(["chat", "changes", "list", id, "--json"])).stdout) as { files: Array<{ path: string; reviewed?: boolean }> };
    expect(list.files.map((f) => f.path).sort()).toEqual([a, b].sort());

    const turns = JSON.parse((await ok(["chat", "turns", id, "--json"])).stdout) as { turns: Array<{ n: number; calls: string[] }> };
    expect(turns.turns.map((t) => [t.n, t.calls])).toEqual([[1, ["toolu_1"]], [2, ["toolu_2", "toolu_3"]]]);

    const diff = await ok(["chat", "changes", "diff", id, `${sub}/a.ts`]);
    expect(diff.stdout).toContain("+five");
    expect(diff.stdout).toContain("@@ ");

    const kept = await ok(["chat", "changes", "keep", id, `${sub}/b.ts`]);
    expect(kept.stdout).toContain(`kept: ${sub}/b.ts`);
    const undoId = /Undo: ppm chat changes undo \S+ (\S+)/.exec(kept.stdout)![1]!;
    expect(JSON.parse((await ok(["chat", "changes", "list", id, "--json"])).stdout).files.find((f: { path: string }) => f.path === b).reviewed).toBe(true);
    await ok(["chat", "changes", "undo", id, undoId]);
    expect(JSON.parse((await ok(["chat", "changes", "list", id, "--json"])).stdout).files.find((f: { path: string }) => f.path === b).reviewed).toBeUndefined();
  }, 120_000);

  it("previews a turn revert without writing, writes exactly the preview's files with --yes, and Undo restores them byte for byte", async () => {
    const { id, a, b } = await seededChat();
    const before = { a: read(a), b: read(b) };

    const preview = await ok(["chat", "revert-turn", id, "2"]);
    expect(preview.stdout).toContain("Nothing was written");
    expect({ a: read(a), b: read(b) }).toEqual(before);

    const applied = await ok(["chat", "revert-turn", id, "2", "--yes"]);
    expect(applied.stdout).toContain("Reverted turn 2");
    // Turn 1's change stays; turn 2's are taken back.
    expect(read(a)).toBe(SEED_BASE.replace("line 5\n", "five\n"));
    expect(read(b)).toBe(SEED_B);

    const undoId = /Undo: ppm chat changes undo \S+ (\S+)/.exec(applied.stdout)![1]!;
    await ok(["chat", "changes", "undo", id, undoId]);
    expect({ a: read(a), b: read(b) }).toEqual(before);
  }, 120_000);

  it("writes nothing when a file is touched between the preview and the approval", async () => {
    const { id, a, b } = await seededChat();
    const preview = await post<{ files: Array<{ path: string; version: string }> }>(id, "/revert-turn", { calls: ["toolu_2", "toolu_3"] });
    expect(preview.files.map((f) => f.path).sort()).toEqual([a, b].sort());
    // Touched after the preview: a later size, so its version moves.
    writeFileSync(b, "alpha\nBETA\ngamma\n");
    const aBefore = read(a);
    const applied = await post<{ stale?: boolean }>(id, "/revert-turn", {
      calls: ["toolu_2", "toolu_3"], apply: preview.files.map((f) => ({ path: f.path, version: f.version })),
    });
    expect(applied.stale).toBe(true);
    expect(read(a)).toBe(aBefore);
    expect(read(b)).toBe("alpha\nBETA\ngamma\n");
  }, 120_000);

  it("reverts one file and refuses a turn it cannot name", async () => {
    const { id, a, sub } = await seededChat();
    const reverted = await ok(["chat", "changes", "revert", id, `${sub}/a.ts`]);
    expect(reverted.stdout).toContain(`reverted: ${sub}/a.ts`);
    expect(read(a)).toBe(SEED_BASE);

    const r = await runCli(home, ["chat", "revert-turn", id, "9", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no turn 9");
  }, 120_000);
});
