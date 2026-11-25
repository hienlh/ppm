/**
 * `ppm speech learned` with a server holding the database: a chat or a manager chat lists the
 * voice word lists and undoes a wrong learned word through the Voice pane's own route on the
 * running PPM — the CLI proves the server and sends the token itself, so nobody reads it. The words
 * are the ones the PPM Assistant's lists held on 25/11/2026.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { rmSync } from "node:fs";
import { runCli, scratchHome, startScratchServer, type ScratchServer } from "../helpers/cli-scratch-server.ts";

let home: string;
let server: ScratchServer;
const target = () => `→ PPM default (ppm.db) at 127.0.0.1:${server.port}`;
const P = "__assistant__";

async function ok(args: string[]) {
  const r = await runCli(home, args);
  expect({ args, code: r.code, err: r.stderr }).toMatchObject({ args, code: 0 });
  expect(r.stderr).toContain(target());
  return r;
}

type Lists = { project: string; learned: Array<{ word: string; from: string }>; learning: Array<{ from: string; to: string }>; undone: Array<{ word: string; from: string }> };
const list = async () => JSON.parse((await ok(["speech", "learned", "list", "--json"])).stdout) as Lists;
/** The server's own memory, not the database: the change has to have reached the running PPM. */
const serverLists = async () => ((await server.config()).voice_message as { projects: Record<string, { learned: Array<{ word: string }>; candidates?: Array<{ to: string }>; blocked?: Array<{ word: string }> }> }).projects[P]!;

beforeAll(async () => {
  home = scratchHome();
  server = await startScratchServer(home, null);
  const at = new Date().toISOString();
  await server.scratch("seed-voice", {
    enabled: true, self_learning: true, review_before_send: false, words: [],
    projects: {
      [P]: {
        words: [],
        learned: [{ word: "bỏ 20", from: "mức reboot", at, source: "edit" }, { word: "Zalo", from: "gia lô", at, source: "chat", hits: 3, kind: "term" }],
        candidates: [{ from: "Spring 57", to: "Sprint 57", hits: 1, at, source: "chat", chats: ["a693b78b@2026-11-25"] }],
      },
    },
  });
}, 60_000);
afterAll(async () => {
  await server?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("ppm speech learned through the server", () => {
  it("lists the Assistant's words by default", async () => {
    const lists = await list();
    expect(lists.project).toBe(P);
    expect(lists.learned.map((l) => `${l.from} → ${l.word}`)).toEqual(["mức reboot → bỏ 20", "gia lô → Zalo"]);
    expect(lists.learning.map((c) => `${c.from} → ${c.to}`)).toEqual(["Spring 57 → Sprint 57"]);
    const text = (await ok(["speech", "learned", "list"])).stdout;
    expect(text).toContain("mức reboot → bỏ 20");
    expect(text).toContain("1 of 3 chats or days");
  }, 60_000);

  it("undoes a wrong learned word in the running PPM, and restores it", async () => {
    const r = await ok(["speech", "learned", "remove", "bỏ 20"]);
    expect(r.stdout).toContain("Undid mức reboot → bỏ 20");
    expect((await serverLists()).learned.map((l) => l.word)).toEqual(["Zalo"]);
    expect((await list()).undone.map((b) => b.word)).toEqual(["bỏ 20"]);

    await ok(["speech", "learned", "restore", "BỎ 20", "--project", P]);
    expect((await serverLists()).learned.map((l) => l.word).sort()).toEqual(["Zalo", "bỏ 20"]);
  }, 60_000);

  it("stops a pair still being learned, by the word it means", async () => {
    const r = await ok(["speech", "learned", "remove", "sprint 57"]);
    expect(r.stdout).toContain("Stopped learning Spring 57 → Sprint 57");
    expect((await serverLists()).candidates ?? []).toEqual([]);
    expect((await serverLists()).blocked?.map((b) => b.word)).toEqual(["Sprint 57"]);
  }, 60_000);

  it("says so for a word in neither list, and changes nothing", async () => {
    const r = await runCli(home, ["speech", "learned", "remove", "Slack"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("neither learned nor being learned");
    expect((await serverLists()).learned).toHaveLength(2);
  }, 60_000);
});
