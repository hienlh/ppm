import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { CodexJsonRpcClient, buildSpawnEnv } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";

function feed(stream: EventEmitter, s: string) {
  stream.emit("data", Buffer.from(s));
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("CodexJsonRpcClient framing", () => {
  it("buffers a partial trailing line until the newline arrives", () => {
    const c = new CodexJsonRpcClient();
    const stdout = new EventEmitter();
    const seen: string[] = [];
    c.onNotification((n) => seen.push(n.method));
    c.attach(stdout as any);
    feed(stdout, '{"method":"a"}\n{"method":"b","par');
    expect(seen).toEqual(["a"]);
    feed(stdout, 'ams":{}}\n');
    expect(seen).toEqual(["a", "b"]);
  });

  it("skips malformed lines without throwing", () => {
    const c = new CodexJsonRpcClient();
    const stdout = new EventEmitter();
    const seen: string[] = [];
    c.onNotification((n) => seen.push(n.method));
    c.attach(stdout as any);
    expect(() => feed(stdout, "{not json\n{\"method\":\"ok\"}\n")).not.toThrow();
    expect(seen).toEqual(["ok"]);
  });
});

describe("CodexJsonRpcClient correlation + id-safety", () => {
  it("resolves the matching request id", async () => {
    const c = new CodexJsonRpcClient();
    const stdout = new EventEmitter();
    c.attach(stdout as any);
    const p = c.request("m"); // id 1
    feed(stdout, '{"id":1,"result":{"ok":true}}\n');
    expect(await p).toEqual({ ok: true });
  });

  it("drops a response whose id is not pending (no throw)", async () => {
    const c = new CodexJsonRpcClient();
    const stdout = new EventEmitter();
    c.attach(stdout as any);
    let resolved = false;
    const p = c.request("m").then(() => { resolved = true; }); // id 1
    feed(stdout, '{"id":99,"result":1}\n'); // non-pending → dropped
    await tick();
    expect(resolved).toBe(false);
    feed(stdout, '{"id":1,"result":1}\n');
    await p;
    expect(resolved).toBe(true);
  });

  it("a ServerRequest with an id colliding a pending client id does NOT resolve the client promise", async () => {
    const c = new CodexJsonRpcClient();
    const stdout = new EventEmitter();
    const serverReqs: Array<number | string> = [];
    c.onServerRequest((r) => serverReqs.push(r.id));
    c.attach(stdout as any);
    let resolved = false;
    const p = c.request("m").then(() => { resolved = true; }); // id 1
    feed(stdout, '{"id":1,"method":"item/commandExecution/requestApproval","params":{}}\n');
    await tick();
    expect(serverReqs).toEqual([1]);     // routed to server-request handler
    expect(resolved).toBe(false);        // pending client promise untouched
    feed(stdout, '{"id":1,"result":1}\n'); // real response now resolves it
    await p;
    expect(resolved).toBe(true);
  });

  it("classifies notification vs serverRequest vs response", async () => {
    const c = new CodexJsonRpcClient();
    const stdout = new EventEmitter();
    const notifs: string[] = [];
    const reqs: string[] = [];
    c.onNotification((n) => notifs.push(n.method));
    c.onServerRequest((r) => reqs.push(r.method));
    c.attach(stdout as any);
    feed(stdout, '{"method":"item/agentMessage/delta","params":{"delta":"x"}}\n');
    feed(stdout, '{"id":5,"method":"item/fileChange/requestApproval","params":{}}\n');
    await tick();
    expect(notifs).toEqual(["item/agentMessage/delta"]);
    expect(reqs).toEqual(["item/fileChange/requestApproval"]);
  });
});

describe("buildSpawnEnv allowlist", () => {
  it("excludes ANTHROPIC_API_KEY and keeps PATH", () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env.ANTHROPIC_BASE_URL = "http://leak";
    const env = buildSpawnEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.PATH ?? env.Path).toBeDefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it("keeps CODEX_ / XDG_ prefixed vars", () => {
    process.env.CODEX_HOME = "/x/.codex";
    const env = buildSpawnEnv();
    expect(env.CODEX_HOME).toBe("/x/.codex");
    delete process.env.CODEX_HOME;
  });
});
