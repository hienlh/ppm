import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectRestartCaller, describeRestartCaller, logRestartCaller, processName, redactCommandLine, requestedBySummary,
} from "../../../src/services/restart-news/restart-caller.ts";
import {
  parseProcCmdline, parseProcStatPpid, parsePsLine, parseWindowsWalk, readAncestors, windowsWalkScript,
} from "../../../src/services/restart-news/restart-caller-process-chain.ts";
import {
  peekRestartRequester, readStartReasonEnv, requesterNote, startReasonEnv, takeRestartRequest, writeRestartRequest,
} from "../../../src/services/restart-news/start-reason.ts";
import { decideServerExit, initialStartReason, mergeRequest, resumeAfterStopReason } from "../../../src/services/restart-news/supervisor-start-reason.ts";
import { describeStart } from "../../../src/services/restart-news/server-run-log.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "ppm-caller-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const ANCESTORS = [
  { pid: 200, ppid: 300, name: "bash.exe", cmd: "bash -c \"ppm restart --token abc123secretvalue\"" },
  { pid: 300, ppid: 400, name: "claude.exe", cmd: "claude.exe --api-key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA --print" },
  { pid: 400, ppid: 1, name: "bun.exe", cmd: "bun run server CLAUDE_CODE_OAUTH_TOKEN=oauthsecret123 -Password 'p a s s'" },
];

describe("redactCommandLine", () => {
  test("takes out secrets passed as separate arguments and as name=value", () => {
    const out = redactCommandLine("tool --token abc123 --password \"two words\" -ApiKey xyz api_key=k1 Authorization: Bearer zzz");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("two words");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("k1");
    expect(out).not.toContain("zzz");
    expect(out.startsWith("tool --token [REDACTED]")).toBe(true);
  });
  test("keeps paths, pids, session ids and ordinary flags", () => {
    const line = "C:\\Users\\dev\\ppm\\ppm.exe restart --reason watchdog 53952680-0b07-4f6a-9c1d-123456789abc";
    expect(redactCommandLine(line)).toBe(line);
  });
});

describe("process chain parsing", () => {
  test("/proc stat ppid survives a name with spaces and parentheses", () => {
    expect(parseProcStatPpid("123 (my (odd) prog) S 456 123 123 0")).toBe(456);
    expect(parseProcStatPpid("garbage")).toBeUndefined();
  });
  test("/proc cmdline and ps output", () => {
    expect(parseProcCmdline("bun\0run\0ppm restart\0")).toBe("bun run ppm restart");
    expect(parsePsLine(9, "  42 /bin/zsh -l\n")).toEqual({ pid: 9, ppid: 42, cmd: "/bin/zsh -l" });
    expect(parsePsLine(9, "")).toBeNull();
  });
  test("the Windows walk is base64 JSON, one object or many", () => {
    const one = Buffer.from(JSON.stringify({ pid: 5, ppid: 6, name: "pwsh.exe", cmd: "pwsh -c ppm" })).toString("base64");
    expect(parseWindowsWalk(one)).toEqual([{ pid: 5, ppid: 6, name: "pwsh.exe", cmd: "pwsh -c ppm" }]);
    const many = Buffer.from(JSON.stringify([{ pid: 5, ppid: 6, name: "", cmd: "" }, { pid: 6 }])).toString("base64");
    expect(parseWindowsWalk(many)).toEqual([{ pid: 5, ppid: 6 }, { pid: 6 }]);
    expect(parseWindowsWalk("not base64 json")).toEqual([]);
    expect(windowsWalkScript(77, 4)).toContain("$id=77");
  });
  test("reads this process's real parent chain", async () => {
    const chain = await readAncestors(process.ppid, 2);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0]!.pid).toBe(process.ppid);
  }, 15_000);
  test("an impossible pid gives an empty chain, not a throw", async () => {
    expect(await readAncestors(0)).toEqual([]);
  });
});

describe("describeRestartCaller", () => {
  const collect = (env: Record<string, string>, reason?: string) => collectRestartCaller("restart", reason, {
    pid: 100, ppid: 200, cwd: "C:\\work\\repo", env, ancestors: async () => ANCESTORS,
  });

  test("names pid, parent, grandparent, cwd, chat mark and reason, with no secret left", async () => {
    const c = await collect({ PPM_AI_CHAT: "1", CLAUDE_CODE_SESSION_ID: "d4e5d0ac-4bae-4d7c-b690-128c8ac34211", HOME: "/x" }, "watchdog: ram");
    const line = describeRestartCaller(c);
    expect(line).toContain("ppm restart run as pid 100");
    expect(line).toContain("parent 200 bash.exe");
    expect(line).toContain("grandparent 300 claude.exe");
    expect(line).toContain("ancestor 3 400 bun.exe");
    expect(line).toContain('cwd "C:\\\\work\\\\repo"');
    expect(line).toContain("PPM_AI_CHAT=1 CLAUDE_CODE_SESSION_ID=d4e5d0ac-4bae-4d7c-b690-128c8ac34211");
    expect(line).toContain('reason "watchdog: ram"');
    expect(line).not.toContain("HOME");
    for (const secret of ["abc123secretvalue", "sk-ant-api03", "oauthsecret123", "p a s s"]) expect(line).not.toContain(secret);
  });

  test("says so when nothing marks a chat and no reason was given", async () => {
    const line = describeRestartCaller(await collect({}));
    expect(line).toContain("no AI-chat mark");
    expect(line).toContain("no --reason");
  });

  test("an unreadable chain is said, not hidden", async () => {
    const c = await collectRestartCaller("stop", undefined, { pid: 1, env: {}, ancestors: async () => { throw new Error("boom"); } });
    expect(describeRestartCaller(c)).toContain("parent process could not be read");
  });

  test("the short form names the chain and the chat session, within 200 characters", async () => {
    const by = requestedBySummary(await collect({ PPM_AI_CHAT: "1", CLAUDE_CODE_SESSION_ID: "abc-session" }));
    expect(by).toBe("ppm restart (pid 100) under bash.exe 200 ← claude.exe 300 ← bun.exe 400, from an AI chat (session abc-session)");
    expect(by.length).toBeLessThanOrEqual(200);
  });

  test("processName falls back to the command line's first word", () => {
    expect(processName({ pid: 1, cmd: "\"C:\\Program Files\\x\\tool.exe\" -a" })).toBe("tool.exe");
    expect(processName({ pid: 1, cmd: "/usr/bin/zsh -l" })).toBe("zsh");
    expect(processName({ pid: 1 })).toBe("?");
  });

  test("the ppm.log line is in the logger's format and only goes where a PPM folder exists", async () => {
    const dir = tmp();
    logRestartCaller(dir, await collect({ PPM_AI_CHAT: "1" }, "manual"));
    const text = readFileSync(join(dir, "ppm.log"), "utf8");
    expect(text).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] \[INFO\] \[restart-caller\] ppm restart run as pid 100; /);
    expect(text).not.toContain("abc123secretvalue");
    logRestartCaller(join(dir, "missing"), await collect({}));
    expect(() => readFileSync(join(dir, "missing", "ppm.log"))).toThrow();
  });
});

describe("requestedBy through the request file, the supervisor and the server", () => {
  test("written, peeked without consuming, then taken", () => {
    const dir = tmp();
    writeRestartRequest(dir, { kind: "manual", requestedBy: "ppm restart (pid 1) under bash 2" });
    expect(peekRestartRequester(dir)).toBe("ppm restart (pid 1) under bash 2");
    expect(takeRestartRequest(dir)).toEqual({ kind: "manual", requestedBy: "ppm restart (pid 1) under bash 2" });
    expect(peekRestartRequester(dir)).toBeUndefined();
  });

  test("a stale request names nobody", () => {
    const dir = tmp();
    writeRestartRequest(dir, { kind: "manual", requestedBy: "old" }, Date.now() - 10 * 60_000);
    expect(peekRestartRequester(dir)).toBeUndefined();
  });

  test("the supervisor's note names the asker, or says none was recorded", () => {
    expect(requesterNote("ppm restart (pid 1)")).toBe(" (requested by ppm restart (pid 1))");
    expect(requesterNote(undefined)).toContain("no caller recorded");
    expect(requesterNote(42)).toContain("no caller recorded");
  });

  test("a request with no --reason keeps the supervisor's words and adds the asker", () => {
    const bare = () => ({ kind: "manual" as const, requestedBy: "ppm restart (pid 7)" });
    expect(resumeAfterStopReason(bare)).toEqual({ kind: "manual", detail: "resumed after ppm stop", requestedBy: "ppm restart (pid 7)" });
    const exit = { exitCode: 0, signal: "SIGTERM", upForS: 5, stopped: false, shuttingDown: false, healthKill: false, restartRequested: true };
    expect(decideServerExit(exit, bare)).toEqual({ action: "respawn_now", reason: { kind: "manual", requestedBy: "ppm restart (pid 7)" } });
    expect(initialStartReason({ isUpgrade: false, uptimeS: 30, takeRequest: bare }).requestedBy).toBe("ppm restart (pid 7)");
  });

  test("a request with its own reason replaces the fallback and keeps the asker", () => {
    const r = { kind: "watchdog" as const, detail: "ram", requestedBy: "x" };
    expect(mergeRequest(r, { kind: "manual", detail: "fallback" })).toEqual(r);
    expect(mergeRequest(null, { kind: "manual" })).toEqual({ kind: "manual" });
  });

  test("it reaches the server through the environment and lands in the restart entry", () => {
    const env = startReasonEnv({ kind: "manual", requestedBy: "ppm restart (pid 7)" });
    const given = readStartReasonEnv(env);
    expect(given).toEqual({ kind: "manual", requestedBy: "ppm restart (pid 7)" });
    expect(describeStart(1, "1.0.0", given, null).requestedBy).toBe("ppm restart (pid 7)");
  });
});
