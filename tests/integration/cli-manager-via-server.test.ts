/**
 * `ppm manager` with a server holding the database: `list`, `assign` and `unassign` go through
 * `/api/assistant/managers`, the routes the session list's "Set as manager chat" calls, so the
 * rules file is written and `assistant:managers_changed` announced exactly as for a click; an
 * existing manager is replaced only with `--replace`; `assign` and `unassign` are refused from an
 * AI chat before any request, pointing to the Assistant's tools. Run against a scratch server with
 * the real chat stack (`cli-chat-scratch-server-main.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
const AI = { PPM_AI_CHAT: "1" };
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;
const dirOf = (name: string) => join(home, "work", name);
const announced = async () => (await server.events()).filter((e) => e.type === "assistant:managers_changed").length;

async function cli(args: string[], env: Record<string, string> = {}) {
  const r = await runCli(home, args, env);
  return { ...r, stdout: r.stdout.replace(/\x1b\[[0-9;]*m/g, ""), stderr: r.stderr.replace(/\x1b\[[0-9;]*m/g, "") };
}
async function ok(args: string[], env: Record<string, string> = {}) {
  const r = await cli(args, env);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ args, code: 0 });
  return r;
}
async function refused(args: string[], message: string, env: Record<string, string> = {}) {
  const r = await cli(args, env);
  expect({ args, code: r.code }).toEqual({ args, code: 1 });
  expect(r.stderr).toContain(message);
  return r;
}
async function createChat(project: string, title: string): Promise<string> {
  const r = await ok(["chat", "create", "-p", project, "-t", title]);
  const id = /Created session: (\S+)/.exec(r.stdout)![1]!;
  // PPM's own title, the one the manager list reads.
  await ok(["chat", "rename", id, title]);
  return id;
}
const managers = async () => JSON.parse((await ok(["manager", "list", "--json"])).stdout) as Array<{ projectName: string; sessionId: string }>;

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null, undefined, "cli-chat-scratch-server-main.ts");
  for (const name of ["alpha", "beta"]) {
    mkdirSync(dirOf(name), { recursive: true });
    await ok(["projects", "add", dirOf(name), "-n", name]);
  }
}, 90_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm manager through the server", () => {
  it("assigns, replaces only when asked, and unassigns through the session list's routes", async () => {
    const empty = await ok(["manager", "list"]);
    expect(empty.stderr).toContain(target());
    expect(empty.stdout).toContain("No manager chats yet.");

    const first = await createChat("alpha", "Quản lý");
    const second = await createChat("alpha", "Another");
    const before = await announced();

    const assigned = await ok(["manager", "assign", first]);
    expect(assigned.stderr).toContain(target());
    expect(assigned.stdout).toContain(`Manager chat of alpha: ${first}`);
    expect(await managers()).toEqual([expect.objectContaining({ projectName: "alpha", sessionId: first })]);
    expect(await announced()).toBeGreaterThan(before);
    expect(existsSync(join(dirOf("alpha"), ".ppm", "manager.md"))).toBe(true);

    const table = await ok(["manager", "list"]);
    expect(table.stdout).toContain("Quản lý");
    expect((await ok(["manager", "assign", first, "-p", "alpha"])).stdout).toContain("already is the manager chat of alpha");

    await refused(["manager", "assign", second], `alpha already has a manager chat: "Quản lý" (${first})`);
    expect((await managers())[0]!.sessionId).toBe(first);
    const replaced = await ok(["manager", "assign", second, "--replace"]);
    expect(replaced.stdout).toContain(`(replaces ${first}, which keeps its history)`);
    expect((await managers()).map((m) => m.sessionId)).toEqual([second]);

    const gone = await ok(["manager", "unassign", "-p", "alpha"]);
    expect(gone.stdout).toContain("alpha has no manager chat now; the chat is kept.");
    expect(await managers()).toEqual([]);
    expect((await ok(["manager", "unassign", "-p", "alpha"])).stdout).toContain("alpha had no manager chat; nothing changed.");
  }, 180_000);

  it("refuses a chat of another project with the server's own check", async () => {
    const betaChat = await createChat("beta", "Beta chat");
    await refused(["manager", "assign", betaChat, "-p", "alpha"], "That chat belongs to another project, not alpha");
    expect(await managers()).toEqual([]);
  }, 120_000);

  it("refuses assign and unassign from an AI chat before any request, and still lists", async () => {
    const chat = await createChat("alpha", "From AI");
    const a = await refused(["manager", "assign", chat], "manager_assign", AI);
    expect(a.stderr).toContain("refused here from an AI chat");
    expect(a.stderr).not.toContain(target());
    const u = await refused(["manager", "unassign", "-p", "alpha"], "manager_unassign", AI);
    expect(u.stderr).not.toContain(target());
    expect(await managers()).toEqual([]);
    await ok(["manager", "list"], AI);
  }, 120_000);
});
