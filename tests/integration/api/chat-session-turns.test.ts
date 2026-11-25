import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts"; // disable auth
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { app } from "../../../src/server/index.ts";
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { createCodexAccount, removeCodexAccount } from "../../../src/services/codex-account.service.ts";
import { setSessionMetadata } from "../../../src/services/db.service.ts";
import { _setClaudeProjectsRoot } from "../../../src/services/agent-transcript/claude-projects-root.ts";
import { claude, codex, lines } from "../../unit/services/session-turn-fixtures.ts";
import type { ChatMessage } from "../../../src/types/chat.ts";

/**
 * The real history route: Claude through the SDK's `getSessionMessages` (records with no
 * `promptId`), Codex through the provider's rollout reader — both must come back with every
 * message stamped with its turn.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "ppm-turns-route-")));
/** A project of its own, name and folder: other suites register "test" at paths of their own. */
const projectPath = join(root, "proj");
const PROJECT = "session-turns-route";
const slugDir = join(root, "projects", projectPath.replace(/[/\\:.]/g, "-"));
const saved = { claudeConfig: process.env.CLAUDE_CONFIG_DIR };
let codexAccountId = "";
let registeredCodex = false;

beforeAll(() => {
  mkdirSync(slugDir, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = root; // the SDK reads transcripts from <dir>/projects
  _setClaudeProjectsRoot(join(root, "projects"));
  const projects = configService.get("projects").filter((p) => p.name !== PROJECT);
  configService.set("projects", [...projects, { name: PROJECT, path: projectPath }]);
  if (!providerRegistry.get("codex")) {
    providerRegistry.register(new CodexAppServerProvider());
    registeredCodex = true;
  }
  codexAccountId = createCodexAccount({ label: "turns test", type: "apiKey" }).id;
});

afterAll(() => {
  if (saved.claudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claudeConfig;
  _setClaudeProjectsRoot(null);
  configService.set("projects", configService.get("projects").filter((p) => p.name !== PROJECT));
  if (registeredCodex) (providerRegistry as unknown as { providers: Map<string, unknown> }).providers.delete("codex");
  removeCodexAccount(codexAccountId);
  rmSync(root, { recursive: true, force: true });
});

/** Link records into the parent chain the SDK walks back along. */
function chained(records: string[]): string {
  let parent: string | null = null;
  return lines(...records.map((r) => {
    const rec = JSON.parse(r);
    if (rec.type === "user" || rec.type === "assistant") {
      rec.parentUuid = parent;
      parent = rec.uuid;
    }
    return JSON.stringify(rec);
  }));
}

async function history(id: string, providerId: string): Promise<ChatMessage[]> {
  const res = await app.request(`/api/project/${PROJECT}/chat/sessions/${id}/messages?providerId=${providerId}&limit=200`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { messages: ChatMessage[] } }).data.messages;
}

async function turns(id: string, providerId: string, query = ""): Promise<any> {
  const res = await app.request(`/api/project/${PROJECT}/chat/sessions/${id}/turns?providerId=${providerId}${query}`);
  return { status: res.status, body: (await res.json()) as any };
}

const P = (n: number) => `55555555-0000-4000-8000-00000000000${n}`;

describe("GET /chat/sessions/:id/messages — turn stamps", () => {
  it("Claude: every message carries its turn; one turn per real prompt, not per promptId", async () => {
    const id = randomUUID();
    const a2 = randomUUID();
    writeFileSync(join(slugDir, `${id}.jsonl`), chained([
      claude.prompt("first", P(1)),
      claude.assistant("one"),
      claude.toolResult(P(1)),
      claude.taskNotification(P(2)),
      claude.metaContinue(P(2)),
      claude.prompt("second", P(2)),
      claude.assistant("two", a2),
      claude.prompt("third", P(3)),
      claude.assistant("three"),
    ]));
    const messages = await history(id, "claude");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => typeof m.turnId === "string" && typeof m.turnN === "number")).toBe(true);
    expect([...new Set(messages.map((m) => m.turnId))]).toEqual([P(1), P(2), P(3)]);
    expect(messages.find((m) => m.sdkUuid === a2)!.turnN).toBe(2);

    const listed = await turns(id, "claude", `&resolve=${a2}`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.turns.map((t: any) => [t.n, t.turnId, t.prompt])).toEqual([[1, P(1), "first"], [2, P(2), "second"], [3, P(3), "third"]]);
    expect(listed.body.data.resolved).toEqual({ turnId: P(2), n: 2 });

    const one = await app.request(`/api/project/${PROJECT}/chat/sessions/${id}/turns/${P(2)}?providerId=claude`);
    expect(((await one.json()) as any).data).toMatchObject({ turnId: P(2), n: 2, sessionTitle: "first", sessionId: id });
    const bad = await app.request(`/api/project/${PROJECT}/chat/sessions/${id}/turns/not%20an%20id?providerId=claude`);
    expect(bad.status).toBe(400);
    const missing = await app.request(`/api/project/${PROJECT}/chat/sessions/${randomUUID()}/turns?providerId=claude`);
    expect(missing.status).toBe(404);

    // The jump to a turn reads its window through the same mount.
    const win = await app.request(`/api/project/${PROJECT}/chat/sessions/${id}/turn-window?providerId=claude&turn=${P(2)}`);
    expect(win.status).toBe(200);
    const block = ((await win.json()) as any).data;
    expect(block.turns.map((t: any) => t.n)).toEqual([1, 2, 3]);
    expect(block.latestTurnId).toBe(P(3));
  });

  it("Codex: every message carries its turn, steered message and rollback included", async () => {
    const id = randomUUID();
    const T = (n: number) => `019ee344-1111-7000-8000-00000000000${n}`;
    const dir = join(process.env.PPM_HOME!, "codex-accounts", codexAccountId, "sessions", "2026", "11", "03");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-11-03T00-00-00-${id}.jsonl`), lines(
      codex.meta(id, projectPath),
      codex.taskStarted(T(1)), codex.user("one"), codex.agent("a1"), codex.taskComplete(T(1)),
      codex.taskStarted(T(2)), codex.user("two"), codex.agent("partial"), codex.user("steer"), codex.agent("a2"), codex.taskComplete(T(2)),
      codex.taskStarted(T(3)), codex.user("three"), codex.agent("a3"), codex.taskComplete(T(3)),
      codex.rolledBack(1),
      codex.taskStarted(T(4)), codex.user("four"), codex.agent("a4"), codex.taskComplete(T(4)),
    ));
    setSessionMetadata(id, undefined, projectPath);
    const messages = await history(id, "codex");
    expect(messages.map((m) => [m.content, m.turnId, m.turnN])).toEqual([
      ["one", T(1), 1], ["a1", T(1), 1],
      ["two", T(2), 2], ["partial", T(2), 2], ["steer", T(2), 2], ["a2", T(2), 2],
      ["four", T(4), 3], ["a4", T(4), 3],
    ]);
    const listed = await turns(id, "codex");
    expect(listed.body.data.turns.map((t: any) => t.turnId)).toEqual([T(1), T(2), T(4)]);
    const gone = await app.request(`/api/project/${PROJECT}/chat/sessions/${id}/turns/${T(3)}?providerId=codex`);
    expect(gone.status).toBe(410);
  });
});

describe("GET /chat/sessions/:id/export.md and the bookmarks routes", () => {
  it("exports every turn as Markdown, prompts and answers in full, a line per tool call, no tool output", async () => {
    const id = randomUUID();
    writeFileSync(join(slugDir, id + ".jsonl"), chained([
      claude.prompt("Fix the login bug", P(1)),
      // The fixture's tool result answers toolu_1, and a call's id is toolu_ + its uuid's first 8 characters.
      claude.assistant("", "1", { file_path: "src/login.ts", content: "SECRET-TOOL-INPUT-BODY" }),
      claude.toolResult(P(1), randomUUID(), "TOOL-OUTPUT-NOT-EXPORTED"),
      claude.assistant("Fixed it in **src/login.ts**."),
      claude.prompt("Now add a test", P(2)),
      claude.assistant("Added `login.test.ts`."),
    ]));
    const res = await app.request("/api/project/" + PROJECT + "/chat/sessions/" + id + "/export.md?providerId=claude");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("fix-the-login-bug.md");
    const md = await res.text();
    expect(md.startsWith("# Fix the login bug\n")).toBe(true);
    expect(md).toContain("## Turn 1 · ");
    expect(md).toContain("## Turn 2 · ");
    expect(md).toContain("**You**\n\nFix the login bug");
    expect(md).toContain("**Claude**");
    expect(md).toContain("- `Write` `src/login.ts` · ok");
    expect(md).toContain("Fixed it in **src/login.ts**.");
    expect(md).toContain("Added `login.test.ts`.");
    expect(md).not.toContain("TOOL-OUTPUT-NOT-EXPORTED");
    expect(md).not.toContain("SECRET-TOOL-INPUT-BODY");

    const missing = await app.request("/api/project/" + PROJECT + "/chat/sessions/" + randomUUID() + "/export.md?providerId=claude");
    expect(missing.status).toBe(404);
  });

  it("bookmarks a turn, renames it, lists in turn order, and takes it off", async () => {
    const id = randomUUID();
    const url = (turnId = "") => "/api/project/" + PROJECT + "/chat/sessions/" + id + "/bookmarks" + (turnId ? "/" + turnId : "");
    const put = (turnId: string, body: unknown) => app.request(url(turnId), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = async (r: Response) => ((await r.json()) as any).data;

    expect(await data(await app.request(url()))).toEqual([]);
    await put(P(3), { turnN: 3, label: "third" });
    const list = await data(await put(P(1), { turnN: 1, label: "  first  " }));
    expect(list.map((b: any) => [b.turnId, b.turnN, b.label])).toEqual([[P(1), 1, "first"], [P(3), 3, "third"]]);
    expect((await data(await put(P(1), { label: "renamed" })))[0]).toMatchObject({ turnId: P(1), turnN: 1, label: "renamed" });
    expect((await put("not an id", { label: "x" })).status).toBe(400);
    const after = await data(await app.request(url(P(1)), { method: "DELETE" }));
    expect(after.map((b: any) => b.turnId)).toEqual([P(3)]);
  });
});
