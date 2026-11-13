import { describe, test, expect, afterEach } from "bun:test";
import { handleKillRequest, type KillHandlerDeps } from "../../../../src/services/system-metrics/kill-request-handler.ts";
import { handleSignalRequest } from "../../../../src/services/system-metrics/signal-request-handler.ts";
import {
  _clearChatProviderPids, chatProviderPids, registerChatProviderPid, registeredChatProviderPids,
} from "../../../../src/services/system-metrics/chat-provider-pids.ts";
import { buildGuardMaps } from "../../../../src/services/system-metrics/kill-identity-resolver.ts";
import type { ProcessCollector, RawProcessRow } from "../../../../src/services/system-metrics/process-collector-types.ts";
import { raw } from "./fixtures/process-fixtures.ts";

// A stand-in table: server 100 runs a Claude CLI (200, a node) and a codex launcher (300, a bun)
// whose real binary is 310; 210 is a dev server the Claude CLI's shell started; 400 is unrelated;
// 510 is a provider started under a tmux (500) rather than by the server.
const SERVER = 100;
const ROWS: RawProcessRow[] = [
  raw(SERVER, 1, "bun"),
  raw(200, SERVER, "node"),
  raw(210, 200, "vite"),
  raw(300, SERVER, "bun"),
  raw(310, 300, "codex"),
  raw(400, 1, "python"),
  raw(500, 1, "tmux"),
  raw(510, 500, "node"),
];
const quiet = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, isEnabled: () => false };
const providers = (maps: ReturnType<typeof buildGuardMaps>) => chatProviderPids(maps, SERVER);

function deps(executed: number[], aiChat: boolean, rows = ROWS): KillHandlerDeps {
  const collector: ProcessCollector = { collect: async () => ({ rows, warnings: [] }), stop: () => {} };
  return {
    platform: "linux", collector, log: quiet, caller: { aiChat }, providerPids: providers,
    resolveProtected: () => ({ pids: new Set([SERVER]), roots: new Set([SERVER]), selfPid: SERVER }),
    execute: async (pid, tree) => { executed.push(pid); return { pid, tree, method: "signal", killed: [pid] }; },
  };
}

const kill = (pid: number, executed: number[], aiChat: boolean, tree = false) =>
  handleKillRequest({ pid, startedAt: 1_000_000 + pid, tree }, deps(executed, aiChat));

afterEach(() => _clearChatProviderPids());

describe("which processes are a chat's provider", () => {
  test("a registered pid, and a provider-named process under it, while they are alive", () => {
    registerChatProviderPid(200, "claude");
    registerChatProviderPid(300, "codex");
    registerChatProviderPid(999, "claude"); // already gone: not in the table
    expect([...chatProviderPids(buildGuardMaps(ROWS), SERVER)].sort()).toEqual([200, 300, 310]);
  });

  test("a registration is forgotten when its process exits", () => {
    const off = registerChatProviderPid(200, "claude");
    off();
    expect(registeredChatProviderPids().has(200)).toBe(false);
    expect(registerChatProviderPid(undefined, "codex")).toBeInstanceOf(Function);
  });

  test("with nothing registered (the SDK spawned it), a server child that is plainly a provider still counts", () => {
    const rows = [
      raw(SERVER, 1, "bun"),
      raw(220, SERVER, "claude"),
      raw(230, SERVER, "node", { command: "node C:\\ppm\\node_modules\\@anthropic-ai\\claude-agent-sdk\\cli.js --output-format stream-json" }),
      raw(240, SERVER, "bash"),
      raw(250, 1, "claude"), // not PPM's: someone's own terminal session
    ];
    expect([...chatProviderPids(buildGuardMaps(rows), SERVER)].sort()).toEqual([220, 230]);
  });
});

describe("an AI chat may not end a chat's provider", () => {
  test("killing the Claude CLI from an AI chat is refused with 'use chat_stop'", async () => {
    registerChatProviderPid(200, "claude");
    const executed: number[] = [];
    const r = await kill(200, executed, true);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("use chat_stop");
    expect(executed).toEqual([]);
  });

  test("the codex binary under its launcher is refused too, and so is a tree that holds a provider", async () => {
    registerChatProviderPid(300, "codex");
    registerChatProviderPid(510, "claude");
    const executed: number[] = [];
    expect((await kill(310, executed, true)).status).toBe(403);
    expect((await kill(500, executed, true, true)).status).toBe(403);
    expect(executed).toEqual([]);
  });

  test("a signal is held to the same rule", async () => {
    registerChatProviderPid(200, "claude");
    const executed: number[] = [];
    const collector: ProcessCollector = { collect: async () => ({ rows: ROWS, warnings: [] }), stop: () => {} };
    const r = await handleSignalRequest({ pid: 200, startedAt: 1_000_200, signal: "STOP" }, {
      platform: "linux", collector, log: quiet, caller: { aiChat: true }, providerPids: providers,
      supported: ["TERM", "STOP"], resolveProtected: () => ({ pids: new Set([SERVER]), roots: new Set([SERVER]), selfPid: SERVER }),
      execute: async (pid, signal, tree) => { executed.push(pid); return { pid, signal, tree, method: "signal", signalled: [pid] }; },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("use chat_stop");
    expect(executed).toEqual([]);
  });

  test("what a provider's shell started stays the AI's to end", async () => {
    registerChatProviderPid(200, "claude");
    const executed: number[] = [];
    expect((await kill(210, executed, true)).status).toBe(200);
    expect((await kill(400, executed, true)).status).toBe(200);
    expect(executed).toEqual([210, 400]);
  });

  test("a person (no AI mark) can still end a stuck provider from the Task Manager", async () => {
    registerChatProviderPid(200, "claude");
    const executed: number[] = [];
    expect((await kill(200, executed, false)).status).toBe(200);
    expect(executed).toEqual([200]);
  });
});
