/**
 * `ppm chat` and `ppm tags` with a server holding the database: every write goes through the
 * server's own chat and tag routes and announces `sessions:list_changed`; `chat stop` sends the
 * chat socket's stop frame, as PPM's Stop button does; `chat delete` stops a running turn first
 * and deletes nothing when the turn does not stop. Run against a scratch server with the real
 * chat stack and a scripted provider (`cli-chat-scratch-server-main.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;

type Rows = { title: string | null; pinned: boolean; tag: string | null; projectPath: string | null };
type TraceRow = { type: string; payload: { reason?: string } | null };

const rows = (id: string) => server.scratch<Rows>(`chat/rows/${id}`);
const running = async (id: string) => (await server.scratch<{ running: boolean } | null>(`chat/state/${id}`))?.running === true;
const aborts = async (id: string, reason: string) =>
  (await server.scratch<TraceRow[]>(`trace/${id}`)).filter((r) => r.type === "turn_aborted" && r.payload?.reason === reason).length;
const listChanged = async (project: string) =>
  (await server.events()).filter((e) => e.type === "sessions:list_changed" && e.projectName === project).length;

async function createChat(project: string, title: string): Promise<string> {
  const r = await runCli(home, ["chat", "create", "-p", project, "-t", title]);
  expect({ code: r.code, err: r.stderr }).toMatchObject({ code: 0 });
  const plain = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  return /Created session: (\S+)/.exec(plain)![1]!;
}

const ok = async (args: string[], env: Record<string, string> = {}) => {
  const r = await runCli(home, args, env);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ code: 0 });
  return r;
};

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null, undefined, "cli-chat-scratch-server-main.ts");
  for (const name of ["alpha", "beta"]) {
    const dir = join(home, "work", name);
    mkdirSync(dir, { recursive: true });
    await ok(["projects", "add", dir, "-n", name]);
  }
}, 90_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm chat through the server", () => {
  it("creates, renames by a short id, tags and pins a chat, each announced on the project's list", async () => {
    const before = await listChanged("alpha");
    const id = await createChat("alpha", "First");
    expect(await listChanged("alpha")).toBe(before + 1);

    const short = `${id.slice(0, 8)}...`;
    const rename = await ok(["chat", "rename", short, "Renamed"]);
    expect(rename.stderr).toContain(`→ PPM default (ppm.db) at 127.0.0.1:${server.port}`);
    await ok(["tags", "add", "Work", "-p", "alpha", "--color", "#112233"]);
    await ok(["chat", "tag", id, "work"]);
    await ok(["chat", "pin", id]);
    expect(await rows(id)).toMatchObject({ title: "Renamed", pinned: true, tag: "Work" });
    expect(await listChanged("alpha")).toBe(before + 5);

    await ok(["chat", "untag", id]);
    await ok(["chat", "unpin", id]);
    expect(await rows(id)).toMatchObject({ pinned: false, tag: null });

    const list = await ok(["tags", "list", "-p", "alpha", "--json"]);
    expect((JSON.parse(list.stdout) as { tags: Array<{ name: string }> }).tags.map((t) => t.name)).toContain("Work");
    await ok(["tags", "rename", "work", "Later", "-p", "alpha"]);
    await ok(["tags", "remove", "Later", "-p", "alpha"]);
  }, 120_000);

  it("stops a running turn through the chat socket's own stop frame", async () => {
    const id = await createChat("alpha", "Stop me");
    const idle = await ok(["chat", "stop", id]);
    expect(idle.stdout).toContain("No turn is running");

    await server.scratch("chat/start", { sessionId: id, projectName: "alpha" });
    expect(await running(id)).toBe(true);
    const stop = await ok(["chat", "stop", id]);
    expect(stop.stdout).toContain("Stopped");
    expect(await running(id)).toBe(false);
    // The same door a browser's Stop goes through: the chat socket's cancel.
    expect(await aborts(id, "ws_cancel")).toBe(1);
  }, 60_000);

  it("deletes a running chat: one stop, then the delete, then one announcement, and PPM's rows are gone", async () => {
    const id = await createChat("alpha", "Delete me");
    await ok(["chat", "pin", id]);
    await server.scratch("chat/start", { sessionId: id, projectName: "alpha" });
    const before = await listChanged("alpha");

    expect(await rows(id)).toMatchObject({ pinned: true, projectPath: join(home, "work", "alpha") });
    await ok(["chat", "delete", id]);
    expect(await aborts(id, "delete_cancel")).toBe(1);
    expect(await running(id)).toBe(false);
    expect(await rows(id)).toEqual({ title: null, pinned: false, tag: null, projectPath: null });
    expect(await listChanged("alpha")).toBe(before + 1);
  }, 60_000);

  it("deletes nothing when the running turn does not stop", async () => {
    const id = await createChat("alpha", "Stuck");
    await ok(["chat", "pin", id]);
    await server.scratch("chat/start", { sessionId: id, projectName: "alpha" });
    await server.scratch("chat/stuck", { sessionId: id, stuck: true });
    const before = await listChanged("alpha");
    try {
      const r = await runCli(home, ["chat", "delete", id]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("did not stop");
      expect(await rows(id)).toMatchObject({ pinned: true, projectPath: join(home, "work", "alpha") });
      expect(await running(id)).toBe(true);
      expect(await listChanged("alpha")).toBe(before);
    } finally {
      await server.scratch("chat/stuck", { sessionId: id, stuck: false });
    }
  }, 60_000);

  it("refuses to delete another project's chat through this project's name", async () => {
    const id = await createChat("beta", "Theirs");
    await ok(["chat", "pin", id]);
    const r = await runCli(home, ["chat", "delete", id, "-p", "alpha"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Session not found");
    expect(await rows(id)).toMatchObject({ pinned: true, projectPath: join(home, "work", "beta") });
  }, 60_000);

  it("refuses a bulk clean-up from an AI chat before any request", async () => {
    const r = await runCli(home, ["chat", "cleanup", "--older-than", "1", "-p", "alpha"], { PPM_AI_CHAT: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does not clean up chats in bulk");
    expect(r.stderr).not.toContain("→ PPM");
  }, 60_000);
});
