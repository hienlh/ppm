import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import * as accounts from "../../../src/services/codex-account.service.ts";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setSessionMetadata } from "../../../src/services/db.service.ts";

interface LiveThread { threadId: string; client: CodexJsonRpcClient }
interface ProviderInternals {
  connect(id: string): Promise<LiveThread>;
  respawnOn(live: LiveThread, id: string, account: accounts.CodexAccount): Promise<void>;
}

describe("Codex missing rollout guard", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let provider: CodexAppServerProvider;
  let internal: ProviderInternals;
  let requests: string[];
  let rejectStart: boolean;

  beforeEach(() => {
    provider = new CodexAppServerProvider();
    internal = provider as unknown as ProviderInternals;
    requests = [];
    rejectStart = false;
    spies.push(spyOn(accounts, "resolveCodexAccountForSession").mockResolvedValue(null));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method) => {
      requests.push(method);
      if (method === "thread/start") {
        if (rejectStart) throw new Error("temporary start failure");
        return { thread: { id: `test-thread-${crypto.randomUUID()}` } };
      }
      return {};
    }));
  });

  afterEach(() => {
    provider.cleanupAll();
    spies.splice(0).forEach((spy) => spy.mockRestore());
  });

  it("refuses a resumed thread with no rollout instead of replacing its identity", async () => {
    const session = await provider.resumeSession(crypto.randomUUID());
    await expect(internal.connect(session.id)).rejects.toThrow("Cannot resume Codex session");
    expect(requests).not.toContain("thread/start");
    expect(provider.hasStreamingSession(session.id)).toBe(false);
  });

  it("allows an explicitly created session to start, but never restarts either adopted ID or original alias", async () => {
    const session = await provider.createSession({});
    const originalId = session.id;
    const live = await internal.connect(originalId);
    const threadId = live.threadId;
    expect(requests.filter((m) => m === "thread/start")).toHaveLength(1);
    provider.abortQuery(threadId, "test");
    await expect(internal.connect(threadId)).rejects.toThrow("Cannot resume Codex session");
    await expect(internal.connect(originalId)).rejects.toThrow("Cannot resume Codex session");
    expect(requests.filter((m) => m === "thread/start")).toHaveLength(1);
  });

  it("keeps an unstarted session eligible for retry after thread/start fails", async () => {
    const session = await provider.createSession({});
    rejectStart = true;
    const events = [];
    for await (const event of provider.sendMessage(session.id, "hello")) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["error", "done"]);
    expect(provider.hasStreamingSession(session.id)).toBe(false);
    rejectStart = false;
    expect((await internal.connect(session.id)).threadId).toStartWith("test-thread-");
  });

  it("does not replace an existing thread during account rotation when its rollout is missing", async () => {
    const session = await provider.createSession({});
    const live = await internal.connect(session.id);
    const originalId = live.threadId;
    const originalClient = live.client;
    const account: accounts.CodexAccount = {
      id: "test-account", label: "Test", home: process.env.PPM_HOME!,
      type: "apiKey", planType: null, status: "active", addedAt: new Date().toISOString(),
    };
    await expect(internal.respawnOn(live, originalId, account)).rejects.toThrow("Cannot resume Codex session");
    expect(live.threadId).toBe(originalId);
    expect(live.client).toBe(originalClient);
    expect(requests.filter((m) => m === "thread/start")).toHaveLength(1);
  });

  it("still resumes existing history found in another account home", async () => {
    const id = crypto.randomUUID();
    const source: accounts.CodexAccount = {
      id: `source-${id}`, label: "Source", home: join(process.env.PPM_HOME!, `source-${id}`),
      type: "apiKey", planType: null, status: "active", addedAt: new Date().toISOString(),
    };
    const target = { ...source, id: `target-${id}`, home: join(process.env.PPM_HOME!, `target-${id}`) };
    const sourceSessions = join(source.home, "sessions");
    mkdirSync(sourceSessions, { recursive: true });
    const filename = `rollout-test-${id}.jsonl`;
    writeFileSync(join(sourceSessions, filename), JSON.stringify({
      type: "session_meta", payload: { id, cwd: process.cwd(), timestamp: new Date().toISOString() },
    }) + "\n");
    spies.push(spyOn(accounts, "listCodexAccounts").mockReturnValue([source, target]));
    spies.push(spyOn(accounts, "resolveCodexAccountForSession").mockResolvedValue(target));
    setSessionMetadata(id, "test", process.cwd());
    await provider.resumeSession(id);
    expect((await internal.connect(id)).threadId).toBe(id);
    expect(requests).toContain("thread/resume");
    expect(requests).not.toContain("thread/start");
    expect(existsSync(join(target.home, "sessions", filename))).toBe(true);
  });
});
