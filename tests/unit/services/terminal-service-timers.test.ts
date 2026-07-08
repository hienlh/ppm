/**
 * Unit tests for terminal.service.ts timer behavior.
 *
 * Invariant: the idle timer is armed iff session.ws === null.
 * - While a WebSocket is connected, the idle timer is paused (null).
 * - When the WebSocket disconnects, both the 30m grace timer AND the idle
 *   timer are re-armed. Because grace (30m) < idle (1h), the grace timer
 *   fires first on a plain disconnect — that is the decisive kill path.
 * - Reconnecting within the grace period cancels the grace timer and
 *   re-pauses the idle timer.
 *
 * Timer strategy: jest.useFakeTimers() from bun:test intercepts setTimeout
 * globally; jest.advanceTimersByTime(ms) fires any timers whose deadline
 * falls within the advance window — no real-time waiting.
 *
 * PTY strategy: TerminalService is exported so tests can create a fresh
 * instance per test. A fake PtyHandle (no shell spawn) is injected via the
 * _createWithPty test seam on TerminalService.
 */
import { describe, it, expect, beforeEach, afterEach, jest, spyOn } from "bun:test";
import { TerminalService } from "../../../src/services/terminal.service";
import type { PtyHandle } from "../../../src/services/terminal.service";

// ---------------------------------------------------------------------------
// Fake PTY handle — no real shell, tracks kill calls
// ---------------------------------------------------------------------------
function makeFakePty(): PtyHandle & { killCount: number } {
  let _closed = false;
  let killCount = 0;
  return {
    write: (_data: string) => { /* no-op */ },
    resize: (_cols: number, _rows: number) => { /* no-op */ },
    kill() {
      if (_closed) return;
      _closed = true;
      killCount++;
    },
    get closed() { return _closed; },
    get killCount() { return killCount; },
  };
}

// Constants mirror terminal.service.ts (kept in sync manually — if these
// diverge the tests will fail, signalling the constants changed).
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;       // 1 hour
const RECONNECT_GRACE_MS = 30 * 60 * 1000;    // 30 minutes

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("TerminalService timers", () => {
  let svc: TerminalService;

  beforeEach(() => {
    jest.useFakeTimers();
    svc = new TerminalService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Idle timer: connected + silent terminal survives past 1h
  // -------------------------------------------------------------------------
  it("does NOT kill a connected-but-silent terminal after 1h (idle paused while ws attached)", () => {
    // While a WebSocket is connected the idle timer must be paused.
    // Advancing a full hour with no I/O should NOT trigger kill.
    const fakePty = makeFakePty();
    const killSpy = spyOn(svc, "kill");

    const id = svc._createWithPty(fakePty);
    svc.setConnected(id, { send: () => {} }); // attach a fake WS

    // Advance by 1 hour — idle timer must NOT fire
    jest.advanceTimersByTime(IDLE_TIMEOUT_MS);

    expect(killSpy).not.toHaveBeenCalledWith(id);
  });

  // -------------------------------------------------------------------------
  // Grace period: disconnected terminal is killed after 30m
  // -------------------------------------------------------------------------
  it("kills a disconnected terminal after 30m grace period", () => {
    const fakePty = makeFakePty();
    const killSpy = spyOn(svc, "kill");

    const id = svc._createWithPty(fakePty);
    svc.setConnected(id, { send: () => {} });
    svc.setDisconnected(id);

    // Not killed before grace period
    jest.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
    expect(killSpy).not.toHaveBeenCalledWith(id);

    // Killed after grace period
    jest.advanceTimersByTime(1);
    expect(killSpy).toHaveBeenCalledWith(id);
  });

  // -------------------------------------------------------------------------
  // Reconnect within grace: grace cleared, idle stays paused
  // -------------------------------------------------------------------------
  it("does NOT kill if reconnected before grace expires, and idle stays paused past 30m", () => {
    const fakePty = makeFakePty();
    const killSpy = spyOn(svc, "kill");

    const id = svc._createWithPty(fakePty);
    svc.setConnected(id, { send: () => {} });
    svc.setDisconnected(id);

    // Reconnect before grace expires
    jest.advanceTimersByTime(RECONNECT_GRACE_MS / 2);
    svc.setConnected(id, { send: () => {} }); // reconnect: clears grace + pauses idle

    // Advance past original grace deadline and well past the idle timer — must NOT kill
    jest.advanceTimersByTime(RECONNECT_GRACE_MS + IDLE_TIMEOUT_MS);
    expect(killSpy).not.toHaveBeenCalledWith(id);
  });

  // -------------------------------------------------------------------------
  // Write while disconnected resets the idle timer
  // -------------------------------------------------------------------------
  it("resets the idle timer on write() while disconnected", () => {
    // write() calls resetIdleTimer. While disconnected the idle timer is armed,
    // so writing resets the countdown. Advancing to just before 1h, writing,
    // then advancing another ~1h should NOT kill — the timer was reset.
    const fakePty = makeFakePty();
    const killSpy = spyOn(svc, "kill");

    const id = svc._createWithPty(fakePty);
    // Session starts disconnected (ws === null), idle timer armed

    // Advance to just before idle deadline
    jest.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
    expect(killSpy).not.toHaveBeenCalledWith(id);

    // Write resets the idle timer (ws is null, so resetIdleTimer re-arms)
    svc.write(id, "ls\r");

    // Advance another full hour minus 1ms — the reset timer hasn't fired yet
    jest.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
    expect(killSpy).not.toHaveBeenCalledWith(id);

    // Complete the second idle window — now it fires
    jest.advanceTimersByTime(1);
    expect(killSpy).toHaveBeenCalledWith(id);
  });

  // -------------------------------------------------------------------------
  // Write while connected does NOT re-arm the idle timer
  // -------------------------------------------------------------------------
  it("write() while connected does NOT re-arm idle timer (idle stays paused)", () => {
    // When connected, resetIdleTimer should keep idle cleared/null.
    // Advancing 1h after a write on a connected session must NOT kill.
    const fakePty = makeFakePty();
    const killSpy = spyOn(svc, "kill");

    const id = svc._createWithPty(fakePty);
    svc.setConnected(id, { send: () => {} });

    // Write mid-session — must not re-arm idle
    jest.advanceTimersByTime(IDLE_TIMEOUT_MS / 2);
    svc.write(id, "hello\r");

    // Advance well past 1h total — still connected, no kill
    jest.advanceTimersByTime(IDLE_TIMEOUT_MS);
    expect(killSpy).not.toHaveBeenCalledWith(id);
  });

  // -------------------------------------------------------------------------
  // Kill cleanup
  // -------------------------------------------------------------------------
  it("session is removed from internal state after kill", () => {
    const fakePty = makeFakePty();
    const id = svc._createWithPty(fakePty);

    svc.kill(id);

    expect(svc.get(id)).toBeUndefined();
    expect(svc.getBuffer(id)).toBe("");
  });
});
