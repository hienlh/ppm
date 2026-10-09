import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import "../../test-setup.ts"; // disable auth
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { app } from "../../../src/server/index.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { recordBranch } from "../../../src/services/session-branch.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";

const root = mkdtempSync(join(tmpdir(), "ppm-history-cache-"));
const slugDir = join(root, "-tmp-history-cache-proj");
let parses = 0;
/** While set, a parse holds its result until this settles. */
let gate: Promise<void> | null = null;
let spy: ReturnType<typeof spyOn>;

beforeAll(() => {
  mkdirSync(slugDir, { recursive: true });
  _setClaudeProjectsRoot(root);
  const projects = configService.get("projects");
  if (!projects.find((p) => p.name === "test")) {
    projects.push({ name: "test", path: process.cwd() });
    configService.set("projects", projects);
  }
  // Like the SDK, a parse returns what the file held when its read began: one message per line.
  spy = spyOn(chatService, "getMessages").mockImplementation(async (_provider: string, sid: string) => {
    parses++;
    const lines = readFileSync(join(slugDir, `${sid}.jsonl`), "utf8").trim().split("\n").length;
    if (gate) await gate;
    return Array.from({ length: lines }, (_, i) => ({
      id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}`, timestamp: new Date(0).toISOString(),
    })) as any;
  });
});

afterAll(() => {
  spy.mockRestore();
  _setClaudeProjectsRoot(null);
  rmSync(root, { recursive: true, force: true });
});

function newSession(): string {
  const id = randomUUID();
  writeFileSync(join(slugDir, `${id}.jsonl`), `{"type":"user"}\n`);
  return id;
}

const append = (id: string) => appendFileSync(join(slugDir, `${id}.jsonl`), `{"type":"assistant"}\n`);

async function history(id: string, query = "limit=50"): Promise<{ total: number }> {
  const res = await app.request(new Request(
    `http://localhost/api/project/test/chat/sessions/${id}/messages?providerId=claude&${query}`,
  ));
  return ((await res.json()) as any).data;
}

describe("GET /chat/sessions/:id/messages — parsed history cache", () => {
  it("reuses the parse while the transcript is unchanged", async () => {
    const id = newSession();
    parses = 0;
    await history(id);
    await history(id);
    expect(parses).toBe(1);
  });

  it("parses again when a subagent transcript grows, though the main one did not", async () => {
    const id = newSession();
    parses = 0;
    await history(id);
    mkdirSync(join(slugDir, id, "subagents"), { recursive: true });
    appendFileSync(join(slugDir, id, "subagents", "agent-a1.jsonl"), `{"type":"assistant"}\n`);
    await history(id);
    expect(parses).toBe(2);
  });

  it("parses again when the fork root's transcript changes", async () => {
    const rootId = newSession();
    const forkId = newSession();
    recordBranch(forkId, rootId, "m0", 0);
    await history(forkId);
    const before = parses;
    append(rootId);
    await history(forkId);
    expect(parses).toBeGreaterThan(before);
  });

  it("serves older pages from the first page's parse while the turn is still writing", async () => {
    const id = newSession();
    parses = 0;
    await history(id, "limit=4");
    append(id);
    await history(id, "limit=4&before=6");
    append(id);
    await history(id, "limit=4&before=2");
    expect(parses).toBe(1);
  });

  it("does not cache a parse it joined under its own, newer stamp", async () => {
    const id = newSession();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const opening = history(id);  // the parse starts with one line on disk
    await Bun.sleep(10);
    append(id);                   // the turn's last record lands
    const refetch = history(id);  // joins the parse in flight
    await Bun.sleep(10);
    const held = gate;
    gate = null;
    release();
    await held;
    await opening;
    await refetch;
    expect((await history(id)).total).toBe(2);
  });
});
