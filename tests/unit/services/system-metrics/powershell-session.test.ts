import { describe, test, expect } from "bun:test";
import {
  PowerShellSession,
  PsSessionBusyError,
  PsSessionDisabledError,
  POWERSHELL_BOOTSTRAP,
} from "../../../../src/services/system-metrics/powershell-session.ts";
import { createFakeSpawner } from "./fixtures/fake-powershell-child.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("POWERSHELL_BOOTSTRAP", () => {
  test("is one -Command line whose try/catch has no semicolon between the braces", () => {
    expect(POWERSHELL_BOOTSTRAP).not.toContain("\n");
    expect(POWERSHELL_BOOTSTRAP).not.toMatch(/}\s*;\s*catch/);
    expect(POWERSHELL_BOOTSTRAP).toContain("__END_' + $id + '__");
    expect(POWERSHELL_BOOTSTRAP).toContain("[Console]::OutputEncoding=[Text.Encoding]::UTF8");
  });
});

describe("PowerShellSession", () => {
  test("encodes one request as `<id> <base64(UTF-16LE)>` and resolves on its own end marker", async () => {
    const { spawn, children } = createFakeSpawner();
    const s = new PowerShellSession({ spawn });
    const p = s.request("Get-Date");
    await tick();
    const child = children[0]!;
    expect(child.writes).toHaveLength(1);
    expect(child.writes[0]!.endsWith("\n")).toBe(true);
    expect(child.scripts).toEqual(["Get-Date"]);
    expect(child.flushes).toBe(1);
    child.emit("line one\r\nline ");
    child.emit("two\r\n__END_" + child.ids[0] + "__\r\n");
    expect(await p).toBe("line one\r\nline two\r\n");
    expect(s.isHealthy()).toBe(true);
    s.stop();
    expect(child.killed).toBe(true);
    expect(s.isHealthy()).toBe(false);
  });

  test("a second request while one is in flight is rejected (dropped tick), not queued", async () => {
    const { spawn, children } = createFakeSpawner();
    const s = new PowerShellSession({ spawn });
    const first = s.request("a");
    await expect(s.request("b")).rejects.toBeInstanceOf(PsSessionBusyError);
    await tick();
    children[0]!.reply(children[0]!.ids[0]!, "ok");
    expect(await first).toBe("ok\r\n");
    expect(children[0]!.writes).toHaveLength(1);
    s.stop();
  });

  test("desync: a stale marker from a timed-out request is discarded and the next id resyncs", async () => {
    const { spawn, children } = createFakeSpawner();
    const s = new PowerShellSession({ spawn, requestTimeoutMs: 20 });
    await expect(s.request("slow")).rejects.toThrow(/timed out/);
    expect(children[0]!.killed).toBe(true);

    const second = s.request("fast");
    await tick();
    const child = children[1]!;
    // Late garbage carrying the OLD id arrives first, then the real reply.
    child.emit("late output\r\n__END_1__\r\n");
    child.emit("real\r\n__END_" + child.ids[0] + "__\r\n");
    expect(await second).toBe("real\r\n");
    expect(s.restartCount()).toBe(1);
    s.stop();
  });

  test("timeout kills the child, rejects, and the next request restarts on a counted budget", async () => {
    const { spawn, children } = createFakeSpawner();
    const s = new PowerShellSession({ spawn, requestTimeoutMs: 10 });
    await expect(s.request("hang")).rejects.toThrow(/timed out/);
    expect(children[0]!.killed).toBe(true);
    expect(s.isHealthy()).toBe(false);
    const p = s.request("again");
    await tick();
    expect(children).toHaveLength(2);
    children[1]!.reply(children[1]!.ids[0]!, "fine");
    expect(await p).toBe("fine\r\n");
    expect(s.restartCount()).toBe(1);
    s.stop();
  });

  test("an unexpected child exit rejects the in-flight request", async () => {
    const { spawn, children } = createFakeSpawner();
    const s = new PowerShellSession({ spawn });
    const p = s.request("x");
    await tick();
    children[0]!.die(1);
    await expect(p).rejects.toThrow(/exited|closed/);
    expect(s.isHealthy()).toBe(false);
  });

  test("restart budget is an absolute lifetime cap of 5 → permanently disabled", async () => {
    const { spawn, children } = createFakeSpawner();
    const s = new PowerShellSession({ spawn, requestTimeoutMs: 5, maxRestarts: 5 });
    for (let i = 0; i < 6; i++) await expect(s.request("hang")).rejects.toThrow(/timed out/);
    expect(children).toHaveLength(6); // 1 initial + 5 restarts
    await expect(s.request("one more")).rejects.toBeInstanceOf(PsSessionDisabledError);
    expect(s.isDisabled()).toBe(true);
    expect(children).toHaveLength(6);
    // Time passing does not re-arm the budget.
    await new Promise((r) => setTimeout(r, 20));
    await expect(s.request("still")).rejects.toBeInstanceOf(PsSessionDisabledError);
  });

  test("the 6 h recycle spawns a fresh child without spending the restart budget", async () => {
    let now = 0;
    const { spawn, children } = createFakeSpawner({ autoReply: () => "ok" });
    const s = new PowerShellSession({ spawn, recycleAfterMs: 1000, now: () => now });
    expect(await s.request("a")).toBe("ok\r\n");
    now = 500;
    expect(await s.request("b")).toBe("ok\r\n");
    expect(children).toHaveLength(1);
    now = 1000;
    expect(await s.request("c")).toBe("ok\r\n");
    expect(children).toHaveLength(2);
    expect(children[0]!.killed).toBe(true);
    expect(s.restartCount()).toBe(0);
    s.stop();
  });

  test("stop() with nothing running is a no-op and a later request starts fresh", async () => {
    const { spawn, children } = createFakeSpawner({ autoReply: () => "hi" });
    const s = new PowerShellSession({ spawn });
    s.stop();
    expect(children).toHaveLength(0);
    expect(await s.request("x")).toBe("hi\r\n");
    s.stop();
    expect(children[0]!.killed).toBe(true);
    expect(s.childPid()).toBeNull();
  });
});
